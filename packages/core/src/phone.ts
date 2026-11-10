// Phone side: pairing, then staying connected to one desktop.
// Tries the saved LAN addresses first, then a LAN probe, then the relay.

import { Buffer } from "buffer";
import { FramedSocket, type SocketLike } from "./frame.ts";
import { Connection, type Route } from "./connection.ts";
import { HandshakeError, type Platform, clientHandshake } from "./handshake.ts";
import { type Mode, probeProof, randomBytes, relayRoom } from "./crypto.ts";
import { type PairingInfo, parsePairing, parseRelayUrl, splitHostPort } from "./pairing.ts";
import { joinRelay } from "./relay-protocol.ts";
import { Emitter } from "./emitter.ts";
import { type Message } from "./message.ts";

export const DEFAULT_PORT = 47820;
export const PROBE_PORT = 47821;

export interface PairedDesktop {
  id: string;
  name: string;
  key: string; // base64 device key
  hosts: string[];
  relay?: string;
  pairedAt: number;
}

export interface PhoneIdentity {
  id: string;
  name: string;
  platform: Platform;
}

export interface ProbeReply {
  host: string;
  id: string;
  name: string;
  port: number;
}

export interface PhoneTransport {
  connect(host: string, port: number, tls: boolean, timeoutMs: number): Promise<SocketLike>;
  /** Broadcasts one UDP datagram on the LAN and collects JSON replies until the timeout. */
  probe?(payload: Buffer, timeoutMs: number): Promise<{ host: string; reply: any }[]>;
}

export type LinkState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; route: Route; desktopName: string }
  | { kind: "offline"; reason: string; retryInMs: number };

export interface PhoneLinkOptions {
  lanTimeoutMs?: number;
  probeTimeoutMs?: number;
  relayMatchTimeoutMs?: number;
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
  maxBackoffMs?: number;
}

type Events = {
  state: (s: LinkState) => void;
  message: (m: Message, conn: Connection) => void;
  connection: (conn: Connection) => void;
  /** The desktop's saved record changed (new LAN address); persist it. */
  desktopUpdated: (d: PairedDesktop) => void;
};

export class PhoneLink extends Emitter<Events> {
  private desktop: PairedDesktop | null = null;
  private current: Connection | null = null;
  private running = false;
  private wake: (() => void) | null = null;
  private _state: LinkState = { kind: "idle" };
  private readonly o: Required<PhoneLinkOptions>;

  private readonly me: PhoneIdentity;
  private readonly transport: PhoneTransport;

  constructor(me: PhoneIdentity, transport: PhoneTransport, opts: PhoneLinkOptions = {}) {
    super();
    this.me = me;
    this.transport = transport;
    this.o = {
      lanTimeoutMs: 2500,
      probeTimeoutMs: 1500,
      relayMatchTimeoutMs: 8000,
      pingIntervalMs: 20_000,
      idleTimeoutMs: 65_000,
      maxBackoffMs: 30_000,
      ...opts,
    };
  }

  get state(): LinkState {
    return this._state;
  }

  get connection(): Connection | null {
    return this.current?.isOpen ? this.current : null;
  }

  private setState(s: LinkState) {
    this._state = s;
    this.emit("state", s);
  }

  /**
   * Pairs with a desktop from a scanned link or a typed code. On success the new
   * connection stays open and the returned record should be saved.
   */
  async pair(input: string): Promise<PairedDesktop> {
    const info = parsePairing(input);
    if (!info) throw new HandshakeError("bad_code", "that isn't a Pairwise pairing code");
    const attempts = await this.pairCandidates(info);
    let lastError: unknown = new HandshakeError("not_found", "couldn't find the desktop; check you're on the same Wi-Fi");
    for (const a of attempts) {
      try {
        const { conn, issuedKey, desktopId, host } = await a();
        const d: PairedDesktop = {
          id: desktopId,
          name: conn.peerName,
          key: issuedKey.toString("base64"),
          hosts: host ? unique([host, ...info.hosts]) : info.hosts,
          relay: info.relay,
          pairedAt: Date.now(),
        };
        this.desktop = d;
        this.adopt(conn);
        return d;
      } catch (e) {
        lastError = e;
        if (e instanceof HandshakeError && ["bad_key", "not_pairing", "version"].includes(e.code)) throw e;
      }
    }
    throw lastError;
  }

  private async pairCandidates(info: PairingInfo) {
    type Attempt = () => Promise<{ conn: Connection; issuedKey: Buffer; desktopId: string; host?: string }>;
    const out: Attempt[] = [];
    const viaHost = (hp: string, desktopId: string): Attempt => async () => {
      const { host, port } = splitHostPort(hp);
      const sock = await this.transport.connect(host, port, false, this.o.lanTimeoutMs);
      const r = await this.handshake(new FramedSocket(sock), "pair", info.token, desktopId, "lan");
      return { ...r, desktopId, host: hp };
    };
    if (info.desktopId) for (const hp of info.hosts) out.push(viaHost(hp, info.desktopId));
    // LAN probe signed with the token: also the only route for a typed code.
    out.push(async () => {
      const found = await this.probe(info.token, info.desktopId);
      if (!found) throw new HandshakeError("not_found", "couldn't find the desktop on this Wi-Fi");
      return viaHost(`${found.host}:${found.port}`, found.id)();
    });
    if (info.relay && info.desktopId) {
      out.push(async () => {
        const fs = await this.dialRelay(info.relay!, relayRoom(info.token, "pair"));
        const r = await this.handshake(fs, "pair", info.token, info.desktopId!, "relay");
        return { ...r, desktopId: info.desktopId! };
      });
    }
    return out;
  }

  /** Keeps a connection to this desktop alive until stop(), reconnecting with backoff. */
  start(desktop: PairedDesktop) {
    this.desktop = desktop;
    if (this.running) return this.kick();
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
    this.current?.close("stopped");
    this.current = null;
    this.kick();
    this.setState({ kind: "idle" });
  }

  /** Retry right away (call on network changes or when the app comes to the front). */
  kick() {
    this.wake?.();
  }

  private async loop() {
    let backoff = 1000;
    while (this.running) {
      if (!this.connection) {
        this.setState({ kind: "connecting" });
        try {
          const conn = await this.connectOnce(this.desktop!);
          if (!this.running) { conn.close("stopped"); break; }
          this.adopt(conn);
          backoff = 1000;
        } catch (e: any) {
          const reason = String(e?.message ?? e);
          this.setState({ kind: "offline", reason, retryInMs: backoff });
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, this.o.maxBackoffMs);
          continue;
        }
      }
      // Connected: wait until it drops or someone kicks us.
      await new Promise<void>((resolve) => {
        const conn = this.current!;
        const off = conn.on("close", () => { off(); resolve(); });
        this.wake = () => { off(); resolve(); };
      });
      this.wake = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      this.wake = done;
      function done() { clearTimeout(t); resolve(); }
    });
  }

  private adopt(conn: Connection) {
    if (this.current && this.current !== conn) this.current.close("replaced");
    this.current = conn;
    conn.on("message", (m) => this.emit("message", m, conn));
    conn.on("close", (reason) => {
      if (this.current === conn && this.running) this.setState({ kind: "offline", reason, retryInMs: 0 });
    });
    this.setState({ kind: "connected", route: conn.route, desktopName: conn.peerName });
    this.emit("connection", conn);
  }

  /** One full attempt: saved LAN addresses, then a LAN probe, then the relay. */
  async connectOnce(d: PairedDesktop): Promise<Connection> {
    const key = Buffer.from(d.key, "base64");
    const errors: string[] = [];
    for (const hp of d.hosts) {
      try {
        const { host, port } = splitHostPort(hp);
        const sock = await this.transport.connect(host, port, false, this.o.lanTimeoutMs);
        return (await this.handshake(new FramedSocket(sock), "session", key, d.id, "lan")).conn;
      } catch (e: any) {
        if (fatal(e)) throw e;
        errors.push(`${hp}: ${e?.message ?? e}`);
      }
    }
    try {
      const found = await this.probe(key, d.id);
      if (found) {
        const hp = `${found.host}:${found.port}`;
        const sock = await this.transport.connect(found.host, found.port, false, this.o.lanTimeoutMs);
        const { conn } = await this.handshake(new FramedSocket(sock), "session", key, d.id, "lan");
        d.hosts = unique([hp, ...d.hosts]).slice(0, 4);
        this.emit("desktopUpdated", d);
        return conn;
      }
    } catch (e: any) {
      if (fatal(e)) throw e;
      errors.push(`probe: ${e?.message ?? e}`);
    }
    if (d.relay) {
      try {
        const fs = await this.dialRelay(d.relay, relayRoom(key, "session"));
        return (await this.handshake(fs, "session", key, d.id, "relay")).conn;
      } catch (e: any) {
        if (fatal(e)) throw e;
        errors.push(`relay: ${e?.message ?? e}`);
      }
    }
    throw new Error(d.relay ? "desktop not reachable on Wi-Fi or relay" : "desktop not found on this Wi-Fi");
  }

  private async handshake(fs: FramedSocket, mode: Mode, secret: Buffer, desktopId: string, route: Route) {
    try {
      const hs = await clientHandshake(fs, {
        mode, clientId: this.me.id, serverId: desktopId, secret, name: this.me.name, platform: this.me.platform,
      });
      const conn = new Connection(fs, hs, {
        sendPings: true, route, pingIntervalMs: this.o.pingIntervalMs, idleTimeoutMs: this.o.idleTimeoutMs,
      });
      return { conn, issuedKey: hs.issuedKey! };
    } catch (e) {
      fs.close();
      throw e;
    }
  }

  private async dialRelay(url: string, room: string): Promise<FramedSocket> {
    const addr = parseRelayUrl(url);
    if (!addr) throw new Error("bad relay address");
    const sock = await this.transport.connect(addr.host, addr.port, addr.tls, this.o.lanTimeoutMs * 2);
    const fs = new FramedSocket(sock);
    try {
      await joinRelay(fs, room, "phone", this.o.relayMatchTimeoutMs);
      return fs;
    } catch (e) {
      fs.close();
      throw e;
    }
  }

  /** Broadcasts a probe signed with `secret`; returns the matching desktop, if any answered. */
  private async probe(secret: Buffer, desktopId?: string): Promise<ProbeReply | null> {
    if (!this.transport.probe) return null;
    const nonce = randomBytes(16);
    const payload = Buffer.from(JSON.stringify({
      t: "pairwise_probe", v: 2, n: nonce.toString("hex"), p: probeProof(secret, nonce).toString("hex"),
    }));
    const replies = await this.transport.probe(payload, this.o.probeTimeoutMs);
    for (const { host, reply } of replies) {
      if (reply?.t !== "pairwise_here" || reply.n !== nonce.toString("hex")) continue;
      if (desktopId && reply.id !== desktopId) continue;
      if (!/^[0-9a-f]{32}$/.test(String(reply.id)) || !Number.isInteger(reply.port)) continue;
      return { host, id: reply.id, name: String(reply.name ?? ""), port: reply.port };
    }
    return null;
  }

  async sendText(text: string) {
    const c = this.requireConn();
    await c.send("clip_text", {}, Buffer.from(text, "utf8"));
  }

  async sendImage(bytes: Buffer, mime: string) {
    await this.requireConn().send("clip_image", { mime }, bytes);
  }

  private requireConn(): Connection {
    const c = this.connection;
    if (!c) throw new Error("not connected to your computer");
    return c;
  }
}

function fatal(e: any): boolean {
  // The desktop answered and said no: retrying other routes won't help.
  return e instanceof HandshakeError && ["unknown_device", "bad_key", "version"].includes(e.code);
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}
