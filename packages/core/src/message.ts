// Decrypted message format: [u32 BE header length][UTF-8 JSON header][binary body].
// The header always has "t", the message type.

import { Buffer } from "buffer";

export interface Message {
  t: string;
  header: Record<string, any>;
  body: Buffer;
}

export function encodeMessage(t: string, fields: Record<string, any> = {}, body: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.from(JSON.stringify({ ...fields, t }), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length, 0);
  return Buffer.concat([len, h, body]);
}

export function decodeMessage(data: Buffer): Message {
  if (data.length < 4) throw new Error("short message");
  const hlen = data.readUInt32BE(0);
  if (hlen > data.length - 4) throw new Error("bad header length");
  const header = JSON.parse(data.subarray(4, 4 + hlen).toString("utf8"));
  if (typeof header?.t !== "string") throw new Error("message without type");
  return { t: header.t, header, body: Buffer.from(data.subarray(4 + hlen)) };
}

export const CHUNK_SIZE = 256 * 1024;
export const MAX_CLIP_IMAGE = 6 * 1024 * 1024;
export const PING_INTERVAL_MS = 20_000;
export const IDLE_TIMEOUT_MS = 65_000;
