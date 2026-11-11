// The desktop side: accepts phones over the LAN and through the relay, handles pairing,
// clipboard and files. UI-free; the Electron app and the CLI both drive this class.

import { Buffer } from "node:buffer";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { FramedSocket } from "../frame.ts";
import { Connection, type Route } from "../connection.ts";
import { type Platform, serverHandshake } from "../handshake.ts";
import { KEY_LEN, TOKEN_LEN, formatCode, probeProof, randomBytes, relayRoom, safeEqual } from "../crypto.ts";
import { buildPairingUri, parseRelayUrl } from "../pairing.ts";
import { joinRelay } from "../relay-protocol.ts";
import { FileReceiver, type FileSink, type IncomingFile, sendFile } from "../transfer.ts";
import { Emitter } from "../emitter.ts";
import { MAX_CLIP_IMAGE, type Message } from "../message.ts";
import { DEFAULT_PORT, PROBE_PORT } from "../phone.ts";
import { DesktopStore, type PairedPhone } from "./store.ts";
import { connectTcp, lanAddresses } from "./transport.ts";

export interface DesktopOptions {
  dataDir: string;
  name?: string;
  platform?: Platform;
  /** TCP port for phones; 0 picks a free one. Falls back to a free port if taken. */
  port?: number;
  /** UDP probe port; null turns LAN discovery off. */
  probePort?: number | null;
  downloadDir?: string;
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
  /** Host the TCP server and probe listen on. */
  bindHost?: string;
  /** Addresses put in the pairing QR code. Defaults to this machine's LAN IPv4 addresses. */
  advertiseHosts?: string[];
  log?: (line: string) => void;
}

export interface PairingSession {
  uri: string;
  code: string;
  expiresAt: number;
}

type Events = {
  connected: (conn: Connection, phone: PairedPhone) => void;
  disconnected: (phoneId: string, reason: string) => void;
  paired: (phone: PairedPhone) => void;
  pairingEnded: () => void;
  clipText: (text: string, phoneId: string) => void;
  clipImage: (bytes: Buffer, mime: string, phoneId: string) => void;
  fileProgress: (f: IncomingFile, received: number, phoneId: string) => void;
  fileReceived: (filePath: string, f: IncomingFile, phoneId: string) => void;
  fileFailed: (f: IncomingFile, error: string, phoneId: string) => void;
  /** Any other message (notifications, calls, battery...) for the app to handle. */
  message: (m: Message, conn: Connection) => void;
  relayStatus: (status: "off" | "online" | "unreachable", detail?: string) => void;
};

export class DesktopNode extends Emitter<Events> {
  readonly store: DesktopStore;
  private server: net.Server | null = null;
  private probeSock: dgram.Socket | null = null;
  private conns = new Map<string, Connection>();
  private pairing: { token: Buffer; expiresAt: number; timer: NodeJS.Timeout } | null = null;
  private standbys = new Map<string, { stop: () => void }>();
  private stopped = true;
  port = 0;
  private readonly o: DesktopOptions;
  private readonly log: (s: string) => void;

  constructor(o: DesktopOptions) {
    super();
    this.o = o;
    this.log = o.log ?? (() => {});
    this.store = new DesktopStore(o.dataDir, o.name ?? os.hostname().replace(/\.local$/, ""));
    if (o.name) this.store.update((s) => { s.identity.name = o.name!; });
  }

  get id() { return this.store.state.identity.id; }
  get name() { return this.store.state.identity.name; }
  get platform(): Platform {
    return this.o.platform ?? (process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux");
  }
  get downloadDir() {
    return this.store.state.settings.downloadDir ?? this.o.downloadDir ?? path.join(os.homedir(), "Downloads");
  }

  devices(): PairedPhone[] {
    return Object.values(this.store.state.devices);
  }

  connections(): Connection[] {
    return [...this.conns.values()].filter((c) => c.isOpen);
  }

  async start() {
    this.stopped = false;
    this.server = net.createServer((sock) => {
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 30_000);
      void this.accept(new FramedSocket(sock), "lan");
    });
    this.server.maxConnections = 64;
    this.port = await listen(this.server, this.o.port ?? DEFAULT_PORT, this.o.bindHost);
    this.log(`listening on port ${this.port}`);
    if (this.o.probePort !== null) this.startProbeResponder(this.o.probePort ?? PROBE_PORT);
    this.syncStandbys();
  }

  async stop() {
    this.stopped = true;
    this.cancelPairing();
    for (const s of this.standbys.values()) s.stop();
    this.standbys.clear();
    for (const c of this.conns.values()) c.close("desktop stopped");
    this.conns.clear();
    this.probeSock?.close();
    this.probeSock = null;
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  startPairing(ttlMs = 10 * 60_000): PairingSession {
    this.cancelPairing(false);
    const token = randomBytes(TOKEN_LEN);
    const expiresAt = Date.now() + ttlMs;
    const timer = setTimeout(() => this.cancelPairing(), ttlMs);
    timer.unref();
    this.pairing = { token, expiresAt, timer };
    this.syncStandbys();
    const uri = buildPairingUri({
      token,
      desktopId: this.id,
      name: this.name,
      hosts: (this.o.advertiseHosts ?? lanAddresses()).map((a) => `${a}:${this.port}`),
      relay: this.store.state.settings.relay,
    });
    return { uri, code: formatCode(token), expiresAt };
  }

  cancelPairing(notify = true) {
    if (!this.pairing) return;
    clearTimeout(this.pairing.timer);
    this.pairing = null;
    this.syncStandbys();
    if (notify) this.emit("pairingEnded");
  }

  get isPairing() {
    return this.pairing !== null && this.pairing.expiresAt > Date.now();
  }

  revoke(phoneId: string) {
    this.store.update((s) => { delete s.devices[phoneId]; });
    this.conns.get(phoneId)?.close("unpaired");
    this.syncStandbys();
  }

  rename(name: string) {
    this.store.update((s) => { s.identity.name = name.slice(0, 80); });
  }

  setRelay(url: string | null) {
    if (url && !parseRelayUrl(url)) throw new Error("relay address must look like tls://host:443");
    this.store.update((s) => { s.settings.relay = url ?? undefined; });
    for (const s of this.standbys.values()) s.stop();
    this.standbys.clear();
    this.syncStandbys();
  }

  private async accept(fsock: FramedSocket, route: Route) {
    try {
      const hs = await serverHandshake(fsock, {
        serverId: this.id,
        name: this.name,
        platform: this.platform,
        secretFor: (clientId, mode) => {
          if (mode === "pair") return this.isPairing ? this.pairing!.token : { refuse: "not_pairing" };
          const d = this.store.state.devices[clientId];
          return d ? Buffer.from(d.key, "base64") : { refuse: "unknown_device" };
        },
        onPair: (clientId, name, platform) => {
          const key = randomBytes(KEY_LEN);
          const phone: PairedPhone = { id: clientId, name, platform, key: key.toString("base64"), pairedAt: Date.now() };
          this.store.update((s) => { s.devices[clientId] = phone; });
          this.cancelPairing(false); // one-time token
          this.emit("paired", phone);
          return key;
        },
      });
      // The desktop pings too: a backgrounded React Native app can't rely on its own timers,
      // but it always answers a ping as soon as the frame arrives.
      const conn = new Connection(fsock, hs, {
        sendPings: true, route, pingIntervalMs: this.o.pingIntervalMs, idleTimeoutMs: this.o.idleTimeoutMs,
      });
      this.register(conn);
    } catch (e: any) {
      this.log(`handshake failed (${route}): ${e?.message ?? e}`);
      fsock.close();
    }
  }

  private register(conn: Connection) {
    const id = conn.peerId;
    const old = this.conns.get(id);
    this.conns.set(id, conn);
    if (old) old.close("replaced by a newer connection");
    this.store.update((s) => { if (s.devices[id]) s.devices[id].lastSeen = Date.now(); });
    const phone = this.store.state.devices[id];
    this.log(`connected: ${phone?.name ?? id} via ${conn.route}`);

    const files = new FileReceiver(conn, (f) => this.openSink(f), {
      onProgress: (f, n) => this.emit("fileProgress", f, n, id),
      onDone: (f, p) => this.emit("fileReceived", p, f, id),
      onError: (f, e) => this.emit("fileFailed", f, e, id),
    });
    conn.on("message", (m) => {
      if (files.handle(m)) return;
      if (m.t === "clip_text") return this.emit("clipText", m.body.toString("utf8"), id);
      if (m.t === "clip_image") {
        if (m.body.length <= MAX_CLIP_IMAGE) this.emit("clipImage", m.body, String(m.header.mime ?? "image/png"), id);
        return;
      }
      this.emit("message", m, conn);
    });
    conn.on("close", (reason) => {
      if (this.conns.get(id) === conn) {
        this.conns.delete(id);
        this.log(`disconnected: ${phone?.name ?? id} (${reason})`);
        this.emit("disconnected", id, reason);
      }
    });
    this.emit("connected", conn, phone);
  }

  private async openSink(f: IncomingFile): Promise<FileSink> {
    const dir = this.downloadDir;
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.pairwise-${f.id}.part`);
    const handle = await fs.promises.open(tmp, "w", 0o644);
    return {
      write: async (chunk) => { await handle.write(chunk); },
      commit: async () => {
        await handle.close();
        const dest = await uniquePath(dir, safeFileName(f.name));
        await fs.promises.rename(tmp, dest);
        return dest;
      },
      abort: async () => {
        await handle.close().catch(() => {});
        await fs.promises.rm(tmp, { force: true });
      },
    };
  }

  /** Sends clipboard text to every connected phone (or one). */
  async sendText(text: string, phoneId?: string) {
    await this.each(phoneId, (c) => c.send("clip_text", {}, Buffer.from(text, "utf8")));
  }

  async sendImage(bytes: Buffer, mime: string, phoneId?: string) {
    if (bytes.length > MAX_CLIP_IMAGE) return;
    await this.each(phoneId, (c) => c.send("clip_image", { mime }, bytes));
  }

  async sendFile(filePath: string, phoneId?: string, onProgress?: (sent: number, size: number) => void) {
    const stat = await fs.promises.stat(filePath);
    await this.each(phoneId, (c) => sendFile(c, {
      name: path.basename(filePath),
      size: stat.size,
      mime: mimeFor(filePath),
      read: () => fs.createReadStream(filePath, { highWaterMark: 256 * 1024 }) as AsyncIterable<Buffer>,
    }, (p) => onProgress?.(p.sent, p.size)));
  }

  private async each(phoneId: string | undefined, fn: (c: Connection) => Promise<void>) {
    const targets = phoneId ? [this.conns.get(phoneId)].filter(Boolean) as Connection[] : this.connections();
    if (!targets.length) throw new Error("no phone connected");
    await Promise.all(targets.map(fn));
  }

  private startProbeResponder(port: number) {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", (e) => this.log(`probe responder off: ${e.message}`));
    sock.on("message", (msg, rinfo) => {
      if (msg.length > 512) return;
      let p: any;
      try { p = JSON.parse(msg.toString("utf8")); } catch { return; }
      if (p?.t !== "pairwise_probe" || p.v !== 2 || typeof p.n !== "string" || typeof p.p !== "string") return;
      const nonce = Buffer.from(p.n, "hex");
      const proof = Buffer.from(p.p, "hex");
      if (nonce.length !== 16 || proof.length !== 16) return;
      if (!this.probeMatches(nonce, proof)) return;
      const reply = Buffer.from(JSON.stringify({ t: "pairwise_here", v: 2, n: p.n, id: this.id, name: this.name, port: this.port }));
      sock.send(reply, rinfo.port, rinfo.address);
    });
    sock.bind(port, this.o.bindHost);
    this.probeSock = sock;
  }

  /** Answer only phones holding a device key or the live pairing token. */
  private probeMatches(nonce: Buffer, proof: Buffer): boolean {
    const secrets: Buffer[] = this.devices().map((d) => Buffer.from(d.key, "base64"));
    if (this.isPairing) secrets.push(this.pairing!.token);
    return secrets.some((s) => safeEqual(probeProof(s, nonce), proof));
  }

  /** Keeps one waiting relay connection per paired phone (and one for pairing). */
  private syncStandbys() {
    const relay = this.store.state.settings.relay;
    const wanted = new Map<string, string>(); // standby key -> room
    if (relay && !this.stopped) {
      for (const d of this.devices()) wanted.set(`dev:${d.id}`, relayRoom(Buffer.from(d.key, "base64"), "session"));
      if (this.isPairing) wanted.set("pair", relayRoom(this.pairing!.token, "pair"));
    }
    for (const [k, s] of this.standbys) {
      if (!wanted.has(k)) { s.stop(); this.standbys.delete(k); }
    }
    for (const [k, room] of wanted) {
      if (!this.standbys.has(k)) this.standbys.set(k, this.standby(relay!, room));
    }
    if (!relay) this.emit("relayStatus", "off");
  }

  private standby(relayUrl: string, room: string): { stop: () => void } {
    let stopped = false;
    let current: FramedSocket | null = null;
    const addr = parseRelayUrl(relayUrl)!;
    const loop = async () => {
      let backoff = 1000;
      while (!stopped) {
        try {
          const sock = await connectTcp(addr.host, addr.port, addr.tls, 10_000);
          current = new FramedSocket(sock);
          if (stopped) { current.close(); return; }
          this.emit("relayStatus", "online");
          await joinRelay(current, room, "desktop", Number.POSITIVE_INFINITY);
          backoff = 1000;
          const matched = current;
          current = null;
          void this.accept(matched, "relay"); // and immediately wait again for the next one
        } catch (e: any) {
          current?.close();
          current = null;
          if (stopped) return;
          this.emit("relayStatus", "unreachable", e?.message);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    };
    void loop();
    return { stop: () => { stopped = true; current?.close(); } };
  }
}

function listen(server: net.Server, port: number, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE" && port !== 0) {
        server.listen(0, host); // take any free port; phones find it through the probe
        return;
      }
      reject(e);
    };
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      resolve((server.address() as net.AddressInfo).port);
    });
    server.listen(port, host);
  });
}

/** Strips paths and characters that are unsafe on any desktop OS. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  let clean = base.replace(/[\x00-\x1f<>:"|?*]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 200);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean)) clean = `_${clean}`;
  return clean || "file";
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const p = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      await fs.promises.access(p);
    } catch {
      return p;
    }
  }
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".heic": "image/heic", ".pdf": "application/pdf", ".txt": "text/plain", ".zip": "application/zip",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".apk": "application/vnd.android.package-archive",
};

export function mimeFor(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}
