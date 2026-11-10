// Client side of the relay rendezvous. The relay never sees keys or plaintext.
//
// client -> relay: {"relay":1,"room":<64 hex>,"role":"phone"|"desktop"}
// relay -> client: {"waiting":true}            (nobody on the other side yet)
// relay -> client: {"matched":true}            (from here on, bytes are piped to the other side)
// relay -> client: {"error":"..."}             (then closes)

import { FramedSocket } from "./frame.ts";

export const RELAY_PROTOCOL = 1;
export type RelayRole = "phone" | "desktop";

/** Joins a room and resolves once the other side is there. */
export async function joinRelay(fs: FramedSocket, room: string, role: RelayRole, matchTimeoutMs: number): Promise<void> {
  await fs.sendJson({ relay: RELAY_PROTOCOL, room, role });
  const deadline = Date.now() + matchTimeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("the other device isn't on the relay");
    // The relay repeats {"waiting":true} every 30 s; silence for 90 s means the link died.
    const msg = await fs.nextJson(Math.min(left, 90_000));
    if (msg.error) throw new Error(`relay: ${msg.error}`);
    if (msg.matched) return;
  }
}
