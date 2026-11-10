// An established, encrypted connection between a phone and a desktop.
// Handles keep-alives and idle detection; everything else is surfaced as "message" events.

import { Buffer } from "buffer";
import { FramedSocket } from "./frame.ts";
import { type HandshakeResult, type Platform } from "./handshake.ts";
import { IDLE_TIMEOUT_MS, type Message, PING_INTERVAL_MS, decodeMessage, encodeMessage } from "./message.ts";
import { Emitter } from "./emitter.ts";

export type Route = "lan" | "relay";

export interface ConnectionOptions {
  /** Send a ping every interval. Both sides do; each answers the other's pings with pong. */
  sendPings: boolean;
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
  route: Route;
}

type Events = {
  message: (m: Message) => void;
  close: (reason: string) => void;
};

export class Connection extends Emitter<Events> {
  readonly peerId: string;
  readonly peerName: string;
  readonly peerPlatform: Platform;
  readonly route: Route;
  private lastHeard = Date.now();
  private timers: any[] = [];
  private closed = false;

  private readonly fs: FramedSocket;
  private readonly hs: HandshakeResult;

  constructor(fs: FramedSocket, hs: HandshakeResult, o: ConnectionOptions) {
    super();
    this.fs = fs;
    this.hs = hs;
    this.peerId = hs.peerId;
    this.peerName = hs.peerName;
    this.peerPlatform = hs.peerPlatform;
    this.route = o.route;
    const idle = o.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    const ping = o.pingIntervalMs ?? PING_INTERVAL_MS;
    if (o.sendPings) this.timers.push(setInterval(() => this.send("ping").catch(() => {}), ping));
    this.timers.push(setInterval(() => {
      if (Date.now() - this.lastHeard > idle) this.close("peer stopped responding");
    }, Math.min(5000, idle / 2)));
    fs.socket.on("close", () => this.close("connection closed"));
    fs.socket.on("error", (e: Error) => this.close(e.message));
    fs.onFrame((frame) => this.onFrame(frame));
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private onFrame(frame: Buffer) {
    let m: Message;
    try {
      m = decodeMessage(this.hs.cipher.open(frame));
    } catch {
      // A frame that fails authentication means tampering or a desync: drop the connection.
      return this.close("bad frame");
    }
    this.lastHeard = Date.now();
    if (m.t === "ping") return void this.send("pong").catch(() => {});
    if (m.t === "pong") return;
    this.emit("message", m);
  }

  /** Encrypts and sends one message. Order is preserved: frames are sealed in call order. */
  send(t: string, fields: Record<string, any> = {}, body?: Buffer): Promise<void> {
    if (this.closed) return Promise.reject(new Error("not connected"));
    return this.fs.send(this.hs.cipher.seal(encodeMessage(t, fields, body)));
  }

  close(reason = "closed") {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.fs.close();
    this.emit("close", reason);
  }
}
