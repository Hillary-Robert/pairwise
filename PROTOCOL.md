# Pairwise wire protocol (v2)

One implementation of this protocol lives in `packages/core` and runs on every side: the phone
app (React Native), the desktop app (Electron), the CLI and the relay.

## Transport

- **TCP.** The desktop listens on port 47820 (any free port if that one is taken). The phone connects.
- **Framing.** Each frame is `[u32 big-endian length][payload]`, at most 8 MiB.
- **LAN discovery.** UDP port 47821. The phone broadcasts
  `{"t":"pairwise_probe","v":2,"n":<16-byte nonce hex>,"p":<proof hex>}` where
  `proof = HMAC-SHA256(secret, "pairwise-probe|" || nonce)[0..16]` and `secret` is the device key
  (or the pairing token while pairing). The desktop answers only if the proof matches a key it
  holds: `{"t":"pairwise_here","v":2,"n":<nonce>,"id":<desktop id>,"name":…,"port":…}`.
  Strangers on the network get no answer.

## Identity and keys

- Every device has a random 128-bit id (32 hex characters).
- Pairing gives each phone its **own** 256-bit key, so one phone can be unpaired without touching
  the others.

## Pairing

The desktop makes a one-time 128-bit token that expires after 10 minutes or its first use, and shows it as:

- a QR code / link: `pairwise://pair?v=2&t=<base32 token>&d=<desktop id>&n=<name>&h=<host:port,…>&r=<relay url>`
- a typed code: the token in base32, dash-separated groups of 4 (26 characters). With a typed
  code the phone finds the desktop through the LAN probe, signed with the token.

## Handshake

1. Phone -> desktop, plain: `{"v":2,"mode":"pair"|"session","id":<phone id>,"nonce":<base64, 16 bytes>}`
2. Desktop -> phone, plain: `{"v":2,"id":<desktop id>,"nonce":<base64>}`, or
   `{"v":2,"id":<desktop id>,"error":"unknown_device"|"not_pairing"|"version"|"malformed"}` and close.
   The phone checks `id` first: an old address may now belong to a different desktop.
3. Both derive `K = HKDF-SHA256(ikm = secret, salt = Nc || Ns, info = "pairwise-v2|<mode>|<phone id>|<desktop id>", L = 32)`.
   `secret` is the pairing token in pair mode and the device key in session mode. Binding both
   ids and the mode means a forged id can't decrypt anything.
4. Every later frame is `AES-256-GCM(K, nonce, plaintext)`, sent as `ciphertext || tag(16)`, with
   `nonce = [u32 BE direction][u64 BE counter]`: direction 0 = phone->desktop, 1 = desktop->phone,
   counters start at 0. Replayed, reordered or altered frames fail and close the connection.
5. Pair mode only: phone sends `pair_req {name, platform}`; desktop answers
   `pair_ok {key: <base64 32-byte device key>, name}` and burns the token. If the phone's frame
   doesn't decrypt (wrong code), the desktop sends a plain `{"error":"bad_key"}` and closes.
6. Phone sends `hello {name, platform}`; desktop answers `hello {name, platform}`.

## Messages (decrypted)

Each message is `[u32 BE header length][UTF-8 JSON header][binary body]`; the header always has `"t"`.

| t | Direction | Header | Body |
|---|---|---|---|
| `hello` | both | `name`, `platform` | - |
| `ping` / `pong` | both | - | - |
| `clip_text` | both | - | UTF-8 text |
| `clip_image` | both | `mime` | image bytes, ≤ 6 MiB |
| `file_start` | both | `id`, `name`, `size` (-1 if unknown), `mime` | - |
| `file_chunk` | both | `id` | ≤ 256 KiB |
| `file_end` | both | `id`, `sha256` (hex of the whole file) | - |
| `file_done` | receiver to sender | `id`, `ok`, `error?` | - |

Both sides send `ping` every 20 seconds and answer every `ping` with `pong`. A side that hears
nothing for 65 seconds closes the connection, and the phone reconnects with backoff. Unknown
message types are passed to the app and otherwise ignored, so newer features (notifications,
calls, battery) can be added without breaking older peers.

## Relay

Used when the phone can't reach the desktop directly. The relay matches two sockets and pipes bytes.

- Room: `HMAC-SHA256(device key, "pairwise-relay-room")` in hex (`"pairwise-relay-pair"` with the
  pairing token while pairing). Only the paired devices can compute it, and it says nothing about them.
- Client -> relay: `{"relay":1,"room":<64 hex>,"role":"phone"|"desktop"}`
- Relay -> client: `{"waiting":true}` (repeated every 30 s while the desktop waits),
  `{"matched":true}` (from here on, raw bytes are piped to the other side), or `{"error":…}`.
- The desktop keeps one waiting connection per paired phone. A phone whose desktop isn't
  waiting gets `{"error":"desktop_offline"}` straight away.
- The full v2 handshake then runs through the pipe, so the relay only ever sees ciphertext.
- Relay connections use TLS (`tls://host:port`) in normal use; `tcp://` is for testing.
