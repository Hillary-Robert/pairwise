// Owns the PhoneLink, the saved pairing and the background service, and turns
// share-sheet, tile and clipboard events into sends.

import { Buffer } from "buffer";
import * as Clipboard from "expo-clipboard";
import * as SecureStore from "expo-secure-store";
import {
  CHUNK_SIZE, Emitter, FileReceiver, PhoneLink, newDeviceId, sendFile,
  type Connection, type LinkState, type PairedDesktop, type PhoneIdentity,
} from "@pairwise/core";
import Native, { type PendingEvent, type ShareEvent, type SharedFile } from "../modules/pairwise-native";
import { transport } from "./transport";

export interface Activity {
  id: string;
  at: number;
  direction: "in" | "out";
  kind: "text" | "image" | "file";
  label: string;
  ok: boolean;
}

export interface AppState {
  ready: boolean;
  desktop: PairedDesktop | null;
  link: LinkState;
  activity: Activity[];
  transfer: { name: string; done: number; size: number; direction: "in" | "out" } | null;
  copyIncoming: boolean;
}

const KEY_IDENTITY = "pairwise.identity";
const KEY_DESKTOP = "pairwise.desktop";
const KEY_PREFS = "pairwise.prefs";
const MAX_ACTIVITY = 30;

class LinkManager extends Emitter<{ change: (s: AppState) => void }> {
  private link!: PhoneLink;
  private me!: PhoneIdentity;
  state: AppState = {
    ready: false, desktop: null, link: { kind: "idle" }, activity: [], transfer: null, copyIncoming: true,
  };

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.emit("change", this.state);
  }

  async init() {
    if (this.state.ready) return;
    this.me = await loadIdentity();
    const prefs = JSON.parse((await SecureStore.getItemAsync(KEY_PREFS)) ?? "{}");
    const saved = await SecureStore.getItemAsync(KEY_DESKTOP);
    const desktop: PairedDesktop | null = saved ? JSON.parse(saved) : null;

    this.link = new PhoneLink(this.me, transport);
    this.link.on("state", (s) => { this.set({ link: s }); this.updateService(); });
    this.link.on("desktopUpdated", (d) => void this.saveDesktop(d));
    this.link.on("connection", (c) => this.wire(c));

    Native.addListener("onTick", () => { if (!this.link.connection) this.link.kick(); });
    Native.addListener("onNetwork", (e) => { if (e.available) this.link.kick(); });
    Native.addListener("onShare", (e) => void this.handleShare(e));
    Native.addListener("onClipboardCaptured", (e) => void this.sendText(e.text));

    this.set({ ready: true, desktop, copyIncoming: prefs.copyIncoming ?? true });
    if (desktop) this.connect(desktop);
    for (const e of Native.drainPending()) void this.handlePending(e);
  }

  private connect(d: PairedDesktop) {
    this.link.start(d);
    Native.startService("Pairwise", `Connecting to ${d.name}…`);
  }

  private updateService() {
    const d = this.state.desktop;
    if (!d) return;
    const s = this.state.link;
    const text = s.kind === "connected"
      ? `Connected to ${s.desktopName}${s.route === "relay" ? " through your relay" : ""}`
      : s.kind === "offline" ? `Looking for ${d.name}` : `Connecting to ${d.name}…`;
    Native.startService("Pairwise", text);
  }

  private async saveDesktop(d: PairedDesktop | null) {
    if (d) await SecureStore.setItemAsync(KEY_DESKTOP, JSON.stringify(d));
    else await SecureStore.deleteItemAsync(KEY_DESKTOP);
    this.set({ desktop: d });
  }

  async pair(input: string) {
    const d = await this.link.pair(input);
    await this.saveDesktop(d);
    this.connect(d);
  }

  async unpair() {
    this.link.stop();
    Native.stopService();
    await this.saveDesktop(null);
    this.set({ activity: [] });
  }

  async setCopyIncoming(on: boolean) {
    await SecureStore.setItemAsync(KEY_PREFS, JSON.stringify({ copyIncoming: on }));
    this.set({ copyIncoming: on });
  }

  private wire(conn: Connection) {
    const files = new FileReceiver(conn, (f) => {
      const id = Native.beginDownload(f.name, f.mime);
      return {
        write: (chunk) => Native.appendDownload(id, new Uint8Array(chunk)),
        commit: () => Native.commitDownload(id),
        abort: () => Native.abortDownload(id),
      };
    }, {
      onProgress: (f, n) => this.set({ transfer: { name: f.name, done: n, size: f.size, direction: "in" } }),
      onDone: (f) => { this.set({ transfer: null }); this.log("in", "file", `${f.name} saved to Downloads/Pairwise`, true); },
      onError: (f, e) => { this.set({ transfer: null }); this.log("in", "file", `${f.name}: ${e}`, false); },
    });

    conn.on("message", (m) => {
      if (files.handle(m)) return;
      if (m.t === "clip_text") {
        const text = m.body.toString("utf8");
        if (this.state.copyIncoming) void Clipboard.setStringAsync(text);
        this.log("in", "text", text, true);
      } else if (m.t === "clip_image") {
        if (this.state.copyIncoming) void Clipboard.setImageAsync(m.body.toString("base64"));
        this.log("in", "image", "Image copied", true);
      }
    });
  }

  /** Waits briefly for a connection, so a share right after unlocking still goes through. */
  private async whenConnected(timeoutMs = 20_000): Promise<Connection> {
    if (this.link.connection) return this.link.connection;
    if (!this.state.desktop) throw new Error("Pair with your computer first");
    this.link.kick();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`${this.state.desktop?.name ?? "Your computer"} isn't reachable`)); }, timeoutMs);
      const off = this.link.on("connection", (c) => { clearTimeout(timer); off(); resolve(c); });
    });
  }

  async sendText(text: string) {
    try {
      const c = await this.whenConnected();
      await c.send("clip_text", {}, Buffer.from(text, "utf8"));
      this.log("out", "text", text, true);
    } catch (e: any) {
      this.log("out", "text", e.message, false);
      throw e;
    }
  }

  /** Reads the clipboard (only works while the app is on screen) and sends it. */
  async sendClipboard() {
    if (await Clipboard.hasImageAsync()) {
      const img = await Clipboard.getImageAsync({ format: "png" });
      if (img?.data) {
        const c = await this.whenConnected();
        const b64 = img.data.replace(/^data:image\/\w+;base64,/, "");
        await c.send("clip_image", { mime: "image/png" }, Buffer.from(b64, "base64"));
        this.log("out", "image", "Image", true);
        return;
      }
    }
    const text = await Clipboard.getStringAsync();
    if (!text) throw new Error("The clipboard is empty");
    await this.sendText(text);
  }

  async sendFiles(files: SharedFile[]) {
    for (const f of files) {
      try {
        const c = await this.whenConnected();
        const info = f.size >= 0 ? f : { ...f, ...(await Native.fileInfo(f.uri)) };
        await sendFile(c, {
          name: info.name,
          size: info.size,
          mime: info.mime ?? "application/octet-stream",
          read: () => readChunks(f.uri),
        }, (p) => this.set({ transfer: { name: info.name, done: p.sent, size: p.size, direction: "out" } }));
        this.log("out", "file", info.name, true);
      } catch (e: any) {
        this.log("out", "file", `${f.name}: ${e.message}`, false);
      } finally {
        this.set({ transfer: null });
        if (f.uri.includes("/cache/shared/")) void Native.deleteFile(f.uri);
      }
    }
  }

  private async handleShare(e: ShareEvent) {
    if (e.kind === "text") await this.sendText(e.text).catch(() => {});
    else await this.sendFiles(e.files);
  }

  private async handlePending(e: PendingEvent) {
    if (e.event === "onClipboardCaptured") await this.sendText(e.text).catch(() => {});
    else await this.handleShare(e);
  }

  private log(direction: Activity["direction"], kind: Activity["kind"], label: string, ok: boolean) {
    const a: Activity = {
      id: `${Date.now()}-${Math.random()}`, at: Date.now(), direction, kind, ok,
      label: label.length > 200 ? `${label.slice(0, 200)}…` : label,
    };
    this.set({ activity: [a, ...this.state.activity].slice(0, MAX_ACTIVITY) });
  }
}

async function* readChunks(uri: string): AsyncIterable<Buffer> {
  for (let offset = 0; ; offset += CHUNK_SIZE) {
    const bytes = await Native.readChunk(uri, offset, CHUNK_SIZE);
    if (bytes.length) yield Buffer.from(bytes);
    if (bytes.length < CHUNK_SIZE) return;
  }
}

async function loadIdentity(): Promise<PhoneIdentity> {
  const saved = await SecureStore.getItemAsync(KEY_IDENTITY);
  if (saved) return JSON.parse(saved);
  const me: PhoneIdentity = { id: newDeviceId(), name: Native.deviceName(), platform: "android" };
  await SecureStore.setItemAsync(KEY_IDENTITY, JSON.stringify(me));
  return me;
}

export const manager = new LinkManager();
