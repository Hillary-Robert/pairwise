// File transfer over a Connection, with a SHA-256 check on arrival.
//
// sender -> file_start {id, name, size, mime}
// sender -> file_chunk {id} + <= 256 KiB body   (repeated)
// sender -> file_end   {id, sha256}
// receiver -> file_done {id, ok, error?}

import { Buffer } from "buffer";
import { createHash } from "crypto";
import { Connection } from "./connection.ts";
import { CHUNK_SIZE, type Message } from "./message.ts";
import { randomBytes } from "./crypto.ts";

export interface OutgoingFile {
  name: string;
  size: number; // -1 if unknown
  mime: string;
  /** Yields the file's bytes in any chunk size. */
  read: () => AsyncIterable<Buffer | Uint8Array>;
}

export interface TransferProgress {
  id: string;
  name: string;
  sent: number;
  size: number;
}

/** Sends a file and resolves when the receiver confirms the checksum. */
export async function sendFile(
  conn: Connection,
  file: OutgoingFile,
  onProgress?: (p: TransferProgress) => void,
  confirmTimeoutMs = 60_000,
): Promise<void> {
  const id = randomBytes(8).toString("hex");
  const done = waitForDone(conn, id, confirmTimeoutMs);
  done.catch(() => {}); // observed below; avoid an unhandled rejection while sending
  const hash = createHash("sha256");
  let sent = 0;
  await conn.send("file_start", { id, name: file.name, size: file.size, mime: file.mime });
  for await (const piece of file.read()) {
    const buf = Buffer.from(piece);
    for (let off = 0; off < buf.length; off += CHUNK_SIZE) {
      const chunk = buf.subarray(off, off + CHUNK_SIZE);
      hash.update(chunk);
      await conn.send("file_chunk", { id }, chunk);
      sent += chunk.length;
      onProgress?.({ id, name: file.name, sent, size: file.size });
    }
  }
  await conn.send("file_end", { id, sha256: Buffer.from(hash.digest()).toString("hex") });
  await done;
}

function waitForDone(conn: Connection, id: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("receiver didn't confirm the file")), timeoutMs);
    const offMsg = conn.on("message", (m) => {
      if (m.t !== "file_done" || m.header.id !== id) return;
      finish(m.header.ok ? null : new Error(m.header.error ?? "receiver rejected the file"));
    });
    const offClose = conn.on("close", (r) => finish(new Error(`connection lost: ${r}`)));
    function finish(err: Error | null) {
      clearTimeout(timer);
      offMsg();
      offClose();
      err ? reject(err) : resolve();
    }
  });
}

/** Where incoming files go. The desktop writes to disk; the phone to its Downloads folder. */
export interface FileSink {
  write(chunk: Buffer): Promise<void> | void;
  /** Called after the checksum matched. Returns where the file ended up. */
  commit(): Promise<string>;
  abort(): Promise<void> | void;
}

export interface IncomingFile {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface ReceiverEvents {
  onProgress?: (f: IncomingFile, received: number) => void;
  onDone?: (f: IncomingFile, location: string) => void;
  onError?: (f: IncomingFile, error: string) => void;
}

interface Active {
  meta: IncomingFile;
  sink: FileSink;
  hash: ReturnType<typeof createHash>;
  received: number;
  chain: Promise<void>;
  failed?: string;
}

/**
 * Assembles incoming files on a connection. Feed it every message; it consumes file_* messages
 * and returns true for those.
 */
export class FileReceiver {
  private active = new Map<string, Active>();

  private readonly conn: Connection;
  private readonly openSink: (f: IncomingFile) => Promise<FileSink> | FileSink;
  private readonly events: ReceiverEvents;
  private readonly maxSize: number;

  constructor(
    conn: Connection,
    openSink: (f: IncomingFile) => Promise<FileSink> | FileSink,
    events: ReceiverEvents = {},
    maxSize = 4 * 1024 * 1024 * 1024,
  ) {
    this.conn = conn;
    this.openSink = openSink;
    this.events = events;
    this.maxSize = maxSize;
    conn.on("close", () => {
      for (const a of this.active.values()) void Promise.resolve(a.sink.abort()).catch(() => {});
      this.active.clear();
    });
  }

  handle(m: Message): boolean {
    switch (m.t) {
      case "file_start": this.start(m); return true;
      case "file_chunk": this.chunk(m); return true;
      case "file_end": this.end(m); return true;
      default: return false;
    }
  }

  private start(m: Message) {
    const meta: IncomingFile = {
      id: String(m.header.id),
      name: String(m.header.name ?? "file"),
      size: Number(m.header.size ?? -1),
      mime: String(m.header.mime ?? "application/octet-stream"),
    };
    if (meta.size > this.maxSize) {
      void this.conn.send("file_done", { id: meta.id, ok: false, error: "file too large" }).catch(() => {});
      return;
    }
    const a: Active = { meta, sink: null as any, hash: createHash("sha256"), received: 0, chain: Promise.resolve() };
    a.chain = Promise.resolve(this.openSink(meta)).then((s) => { a.sink = s; }, (e) => { a.failed = String(e?.message ?? e); });
    this.active.set(meta.id, a);
  }

  private chunk(m: Message) {
    const a = this.active.get(String(m.header.id));
    if (!a) return;
    const body = m.body;
    a.chain = a.chain.then(async () => {
      if (a.failed) return;
      a.received += body.length;
      if (a.received > this.maxSize) { a.failed = "file too large"; return; }
      a.hash.update(body);
      await a.sink.write(body);
      this.events.onProgress?.(a.meta, a.received);
    }).catch((e) => { a.failed = String(e?.message ?? e); });
  }

  private end(m: Message) {
    const id = String(m.header.id);
    const a = this.active.get(id);
    if (!a) return;
    this.active.delete(id);
    a.chain = a.chain.then(async () => {
      const digest = Buffer.from(a.hash.digest()).toString("hex");
      if (!a.failed && digest !== String(m.header.sha256)) a.failed = "checksum mismatch";
      if (a.failed) {
        await Promise.resolve(a.sink?.abort()).catch(() => {});
        this.events.onError?.(a.meta, a.failed);
        await this.conn.send("file_done", { id, ok: false, error: a.failed }).catch(() => {});
        return;
      }
      const location = await a.sink.commit();
      this.events.onDone?.(a.meta, location);
      await this.conn.send("file_done", { id, ok: true }).catch(() => {});
    }).catch(async (e) => {
      this.events.onError?.(a.meta, String(e?.message ?? e));
      await this.conn.send("file_done", { id, ok: false, error: "receiver failed" }).catch(() => {});
    });
  }
}
