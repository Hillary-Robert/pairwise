// Crypto for protocol v2: HMAC-SHA256 and AES-256-GCM via the "crypto" module
// (react-native-quick-crypto on the phone, aliased in metro.config.js).
// HKDF is implemented here because quick-crypto doesn't have hkdfSync.

import { Buffer } from "buffer";
import { createCipheriv, createDecipheriv, createHmac, randomBytes as cryptoRandom } from "crypto";

export const PROTOCOL_VERSION = 2;
export const KEY_LEN = 32; // per-device key, 256 bits
export const TOKEN_LEN = 16; // one-time pairing token, 128 bits
export const ID_LEN = 16; // device id, 128 bits
export const NONCE_LEN = 16; // handshake nonce
export const TAG_LEN = 16;

export function randomBytes(n: number): Buffer {
  return Buffer.from(cryptoRandom(n));
}

export function newDeviceId(): string {
  return randomBytes(ID_LEN).toString("hex");
}

export function hmac(key: Buffer, data: Buffer | string): Buffer {
  return Buffer.from(createHmac("sha256", key).update(data).digest());
}

/** HKDF-SHA256 (RFC 5869). */
export function hkdf(ikm: Buffer, salt: Buffer, info: string, len = 32): Buffer {
  const prk = hmac(salt.length ? salt : Buffer.alloc(32), ikm);
  const infoBuf = Buffer.from(info, "utf8");
  const blocks: Buffer[] = [];
  let prev: Buffer = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < len; i++) {
    prev = hmac(prk, Buffer.concat([prev, infoBuf, Buffer.from([i])]));
    blocks.push(prev);
  }
  return Buffer.concat(blocks).subarray(0, len);
}

/** Constant-time comparison. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export type Mode = "pair" | "session";

/** HKDF info binds the mode and both device ids, so a spoofed id can't decrypt. */
export function sessionInfo(mode: Mode, clientId: string, serverId: string): string {
  return `pairwise-v2|${mode}|${clientId}|${serverId}`;
}

/** Relay rendezvous room: only the two holders of the secret can compute it. */
export function relayRoom(secret: Buffer, mode: Mode): string {
  return hmac(secret, mode === "pair" ? "pairwise-relay-pair" : "pairwise-relay-room").toString("hex");
}

/** LAN discovery proof: lets the desktop answer only phones it has paired with. */
export function probeProof(key: Buffer, nonce: Buffer): Buffer {
  return hmac(key, Buffer.concat([Buffer.from("pairwise-probe|"), nonce])).subarray(0, 16);
}

/** 12-byte GCM nonce: [u32 BE direction][u64 BE counter]. Counter stays below 2^53. */
export function frameNonce(dir: number, counter: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(dir, 0);
  n.writeUInt32BE(Math.floor(counter / 0x100000000), 4);
  n.writeUInt32BE(counter >>> 0, 8);
  return n;
}

/**
 * AES-256-GCM per-session cipher.
 * key = HKDF-SHA256(secret, salt = clientNonce || serverNonce, info = sessionInfo(...))
 * direction 0 = phone->desktop, 1 = desktop->phone; each direction counts frames from 0.
 */
export class SessionCipher {
  readonly key: Buffer;
  private readonly sendDir: number;
  private readonly recvDir: number;
  private sendCounter = 0;
  private recvCounter = 0;

  constructor(secret: Buffer, clientNonce: Buffer, serverNonce: Buffer, info: string, isServer: boolean) {
    this.key = hkdf(secret, Buffer.concat([clientNonce, serverNonce]), info, 32);
    this.sendDir = isServer ? 1 : 0;
    this.recvDir = isServer ? 0 : 1;
  }

  /** Returns ciphertext || tag. */
  seal(plain: Buffer): Buffer {
    const c = createCipheriv("aes-256-gcm", this.key, frameNonce(this.sendDir, this.sendCounter));
    this.sendCounter++;
    return Buffer.concat([Buffer.from(c.update(plain)), Buffer.from(c.final()), Buffer.from(c.getAuthTag())]);
  }

  /** Throws if the frame wasn't sealed with our key and the expected counter. */
  open(frame: Buffer): Buffer {
    if (frame.length < TAG_LEN) throw new Error("frame too short");
    const d = createDecipheriv("aes-256-gcm", this.key, frameNonce(this.recvDir, this.recvCounter));
    d.setAuthTag(frame.subarray(frame.length - TAG_LEN));
    const plain = Buffer.concat([Buffer.from(d.update(frame.subarray(0, frame.length - TAG_LEN))), Buffer.from(d.final())]);
    this.recvCounter++;
    return plain;
  }
}

// RFC 4648 base32 without padding, for pairing tokens in QR codes and typed codes.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = ((value << 5) | B32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Typed pairing code: base32 in dash-separated groups of 4 ("ABCD-EFGH-..."). */
export function formatCode(token: Buffer): string {
  return base32Encode(token).match(/.{1,4}/g)!.join("-");
}
