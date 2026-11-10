// Protocol v2 handshake. See PROTOCOL.md.
//
// 1. phone -> desktop (plain):  {"v":2,"mode":"pair"|"session","id":<phone id>,"nonce":<b64>}
// 2. desktop -> phone (plain):  {"v":2,"id":<desktop id>,"nonce":<b64>}   or {"v":2,"error":...}
// 3. both: K = HKDF(secret, Nc||Ns, "pairwise-v2|mode|phoneId|desktopId"); every later frame is AES-GCM.
// 4. pair mode only: phone sends pair_req, desktop answers pair_ok with a fresh device key.
// 5. phone sends hello, desktop answers hello.

import { Buffer } from "buffer";
import { FramedSocket } from "./frame.ts";
import { decodeMessage, encodeMessage } from "./message.ts";
import { KEY_LEN, type Mode, NONCE_LEN, PROTOCOL_VERSION, SessionCipher, randomBytes, sessionInfo } from "./crypto.ts";

export type Platform = "android" | "ios" | "mac" | "windows" | "linux" | "test";

export interface HandshakeResult {
  cipher: SessionCipher;
  mode: Mode;
  peerId: string;
  peerName: string;
  peerPlatform: Platform;
  /** Pair mode only: the long-term device key the desktop issued. */
  issuedKey?: Buffer;
}

export class HandshakeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const ID_RE = /^[0-9a-f]{32}$/;
const TIMEOUT = 15000;

export interface ClientOptions {
  mode: Mode;
  clientId: string;
  /** Expected desktop id; the handshake fails if a different desktop answers. */
  serverId: string;
  /** Pairing token in pair mode, device key in session mode. */
  secret: Buffer;
  name: string;
  platform: Platform;
}

export async function clientHandshake(fs: FramedSocket, o: ClientOptions): Promise<HandshakeResult> {
  const nc = randomBytes(NONCE_LEN);
  await fs.sendJson({ v: PROTOCOL_VERSION, mode: o.mode, id: o.clientId, nonce: nc.toString("base64") });
  const reply = await fs.nextJson(TIMEOUT);
  // Check who answered first: an old address may now belong to someone else's desktop,
  // and its refusal must not be mistaken for ours.
  if (reply.id !== o.serverId) throw new HandshakeError("wrong_desktop", "a different desktop answered");
  if (reply.error) throw new HandshakeError(reply.error, describe(reply.error));
  if (reply.v !== PROTOCOL_VERSION) throw new HandshakeError("version", `desktop speaks protocol v${reply.v}`);
  const ns = Buffer.from(String(reply.nonce), "base64");
  if (ns.length !== NONCE_LEN) throw new HandshakeError("bad_nonce", "bad nonce");

  const cipher = new SessionCipher(o.secret, nc, ns, sessionInfo(o.mode, o.clientId, o.serverId), false);
  const send = (t: string, f: Record<string, any> = {}) => fs.send(cipher.seal(encodeMessage(t, f)));
  const recv = async () => {
    const frame = await fs.next(TIMEOUT);
    try {
      return decodeMessage(cipher.open(frame));
    } catch {
      // The desktop couldn't decrypt us and said so in a plain refusal frame.
      throw new HandshakeError("bad_key", o.mode === "pair" ? "pairing code rejected" : "desktop rejected this phone's key");
    }
  };

  let issuedKey: Buffer | undefined;
  if (o.mode === "pair") {
    await send("pair_req", { name: o.name, platform: o.platform });
    const m = await recv();
    if (m.t === "error") throw new HandshakeError(m.header.code ?? "pair_failed", m.header.message ?? "pairing failed");
    if (m.t !== "pair_ok") throw new HandshakeError("protocol", `expected pair_ok, got ${m.t}`);
    issuedKey = Buffer.from(String(m.header.key), "base64");
    if (issuedKey.length !== KEY_LEN) throw new HandshakeError("protocol", "bad device key");
  }

  await send("hello", { name: o.name, platform: o.platform });
  const hello = await recv();
  if (hello.t !== "hello") throw new HandshakeError("protocol", `expected hello, got ${hello.t}`);
  return { cipher, mode: o.mode, peerId: o.serverId, peerName: String(hello.header.name ?? "Desktop"), peerPlatform: hello.header.platform, issuedKey };
}

export interface ServerOptions {
  serverId: string;
  name: string;
  platform: Platform;
  /** Returns the secret for this phone and mode, or a refusal code. */
  secretFor(clientId: string, mode: Mode): Buffer | { refuse: string };
  /** Pair mode: record the new phone and return the device key to issue. */
  onPair(clientId: string, name: string, platform: Platform): Buffer;
}

export async function serverHandshake(fs: FramedSocket, o: ServerOptions): Promise<HandshakeResult> {
  const first = await fs.nextJson(TIMEOUT);
  if (first.v !== PROTOCOL_VERSION) {
    await fs.sendJson({ v: PROTOCOL_VERSION, id: o.serverId, error: "version" }).catch(() => {});
    throw new HandshakeError("version", `phone speaks protocol v${first.v}`);
  }
  const mode: Mode = first.mode === "pair" ? "pair" : "session";
  const clientId = String(first.id ?? "");
  const nc = Buffer.from(String(first.nonce ?? ""), "base64");
  if (!ID_RE.test(clientId) || nc.length !== NONCE_LEN) {
    await fs.sendJson({ v: PROTOCOL_VERSION, id: o.serverId, error: "malformed" }).catch(() => {});
    throw new HandshakeError("malformed", "malformed hello");
  }
  const secret = o.secretFor(clientId, mode);
  if (!Buffer.isBuffer(secret)) {
    await fs.sendJson({ v: PROTOCOL_VERSION, id: o.serverId, error: secret.refuse }).catch(() => {});
    throw new HandshakeError(secret.refuse, describe(secret.refuse));
  }

  const ns = randomBytes(NONCE_LEN);
  await fs.sendJson({ v: PROTOCOL_VERSION, id: o.serverId, nonce: ns.toString("base64") });
  const cipher = new SessionCipher(secret, nc, ns, sessionInfo(mode, clientId, o.serverId), true);
  const send = (t: string, f: Record<string, any> = {}) => fs.send(cipher.seal(encodeMessage(t, f)));
  const recv = async () => {
    const frame = await fs.next(TIMEOUT);
    try {
      return decodeMessage(cipher.open(frame));
    } catch {
      // Tell the phone plainly, so it can say "wrong code" instead of "desktop not found".
      // The refusal carries nothing secret, and the phone can't decrypt it as a valid frame.
      await fs.sendJson({ error: "bad_key" }).catch(() => {});
      throw new HandshakeError("bad_key", mode === "pair" ? "wrong pairing code" : "phone used an unknown key");
    }
  };

  if (mode === "pair") {
    const req = await recv();
    if (req.t !== "pair_req") throw new HandshakeError("protocol", `expected pair_req, got ${req.t}`);
    const key = o.onPair(clientId, String(req.header.name ?? "Phone").slice(0, 80), req.header.platform);
    await send("pair_ok", { key: key.toString("base64"), name: o.name });
  }

  const hello = await recv();
  if (hello.t !== "hello") throw new HandshakeError("protocol", `expected hello, got ${hello.t}`);
  await send("hello", { name: o.name, platform: o.platform });
  return { cipher, mode, peerId: clientId, peerName: String(hello.header.name ?? "Phone").slice(0, 80), peerPlatform: hello.header.platform };
}

function describe(code: string): string {
  switch (code) {
    case "unknown_device": return "this desktop doesn't know this phone; pair again";
    case "not_pairing": return "the pairing code expired; show a new one on the desktop";
    case "version": return "the apps speak different protocol versions; update both";
    default: return code;
  }
}
