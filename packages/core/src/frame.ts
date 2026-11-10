// [u32 BE length][payload] framing, max 8 MiB. Keep one FramedSocket per socket so
// bytes that arrive early (e.g. right after the relay's "matched" frame) aren't lost.

import { Buffer } from "buffer";

/** The socket surface the core needs. Node's net/tls sockets and react-native-tcp-socket both fit. */
export interface SocketLike {
  on(event: "data", cb: (chunk: Buffer) => void): unknown;
  on(event: "close", cb: () => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
  once(event: "drain", cb: () => void): unknown;
  write(data: Buffer | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  end(): unknown;
  destroy(): unknown;
  readonly destroyed?: boolean;
}

export const MAX_FRAME = 8 * 1024 * 1024;

export class FramedSocket {
  private buf: Buffer = Buffer.alloc(0);
  private queue: Buffer[] = [];
  private waiters: { resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  private closedError: Error | null = null;
  private frameListener: ((frame: Buffer) => void) | null = null;

  readonly socket: SocketLike;

  constructor(socket: SocketLike) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(Buffer.from(chunk)));
    socket.on("close", () => this.fail(new Error("connection closed")));
    socket.on("error", (e: Error) => this.fail(e));
  }

  private onData(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME) {
        this.fail(new Error(`frame too large: ${len}`));
        this.socket.destroy();
        return;
      }
      if (this.buf.length < 4 + len) break;
      const frame = Buffer.from(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
      this.deliver(frame);
    }
  }

  private deliver(frame: Buffer) {
    if (this.frameListener) return this.frameListener(frame);
    const w = this.waiters.shift();
    if (w) w.resolve(frame);
    else this.queue.push(frame);
  }

  private fail(e: Error) {
    if (this.closedError) return;
    this.closedError = e;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  get closed(): boolean {
    return this.closedError !== null;
  }

  /** Waits for the next frame. Rejects on close, error or timeout. */
  next(timeoutMs = 15000): Promise<Buffer> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = !Number.isFinite(timeoutMs) ? undefined : setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("timed out waiting for peer"));
      }, timeoutMs);
      const w = {
        resolve: (b: Buffer) => { clearTimeout(timer); resolve(b); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      };
      this.waiters.push(w);
    });
  }

  /** Switches to push mode: every queued and future frame goes to the listener. */
  onFrame(listener: (frame: Buffer) => void) {
    this.frameListener = listener;
    for (const f of this.queue.splice(0)) listener(f);
  }

  /** Writes one frame; resolves once the socket has accepted it (respects backpressure). */
  send(payload: Buffer): Promise<void> {
    if (payload.length > MAX_FRAME) return Promise.reject(new Error("frame too large"));
    if (this.closedError || this.socket.destroyed) return Promise.reject(this.closedError ?? new Error("connection closed"));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return new Promise((resolve, reject) => {
      const ok = this.socket.write(Buffer.concat([header, payload]), (err?: Error | null) => (err ? reject(err) : undefined));
      if (ok) resolve();
      else this.socket.once("drain", () => resolve());
    });
  }

  sendJson(obj: unknown): Promise<void> {
    return this.send(Buffer.from(JSON.stringify(obj), "utf8"));
  }

  async nextJson<T = any>(timeoutMs?: number): Promise<T> {
    const f = await this.next(timeoutMs);
    return JSON.parse(f.toString("utf8")) as T;
  }

  close() {
    this.socket.end();
    const t: any = setTimeout(() => this.socket.destroy(), 1000);
    t?.unref?.();
  }
}
