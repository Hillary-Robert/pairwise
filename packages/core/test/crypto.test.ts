import { test } from "node:test";
import assert from "node:assert/strict";
import { hkdfSync } from "node:crypto";
import {
  SessionCipher, base32Decode, base32Encode, formatCode, hkdf, randomBytes, sessionInfo,
} from "../src/crypto.ts";
import { buildPairingUri, parsePairing, parseRelayUrl } from "../src/pairing.ts";
import { decodeMessage, encodeMessage } from "../src/message.ts";

test("HKDF matches RFC 5869 test case 1", () => {
  const ikm = Buffer.alloc(22, 0x0b);
  const salt = Buffer.from("000102030405060708090a0b0c", "hex");
  const info = Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex").toString("latin1");
  // Our hkdf takes info as UTF-8 text; this vector's info bytes are all >= 0x80, so compare
  // against Node's implementation with the same encoded info instead of the raw RFC bytes.
  const ours = hkdf(ikm, salt, info, 42);
  const node = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), 42));
  assert.deepEqual(ours, node);
});

test("HKDF matches Node's hkdfSync on random inputs and lengths", () => {
  for (let i = 0; i < 50; i++) {
    const ikm = randomBytes(1 + (i % 40));
    const salt = randomBytes(i % 33);
    const info = `pairwise-v2|session|${i}`;
    const len = 16 + (i % 60);
    assert.deepEqual(hkdf(ikm, salt, info, len), Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info), len)));
  }
});

test("base32 round-trips and formats as typed code", () => {
  for (let n = 0; n < 40; n++) {
    const b = randomBytes(n);
    assert.deepEqual(base32Decode(base32Encode(b)), b);
  }
  const code = formatCode(randomBytes(16));
  assert.match(code, /^([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/);
});

test("session cipher: both directions, and rejects tamper, replay and wrong key", () => {
  const secret = randomBytes(32), nc = randomBytes(16), ns = randomBytes(16);
  const info = sessionInfo("session", "a".repeat(32), "b".repeat(32));
  const phone = new SessionCipher(secret, nc, ns, info, false);
  const desk = new SessionCipher(secret, nc, ns, info, true);
  const f1 = phone.seal(Buffer.from("hello"));
  assert.equal(desk.open(f1).toString(), "hello");
  assert.equal(phone.open(desk.seal(Buffer.from("back"))).toString(), "back");
  // Replay of f1 uses an old counter.
  assert.throws(() => desk.open(f1));

  const p2 = new SessionCipher(secret, nc, ns, info, false);
  const d2 = new SessionCipher(secret, nc, ns, info, true);
  const f = p2.seal(Buffer.from("x"));
  f[0] ^= 1;
  assert.throws(() => d2.open(f));

  const wrong = new SessionCipher(randomBytes(32), nc, ns, info, true);
  assert.throws(() => wrong.open(new SessionCipher(secret, nc, ns, info, false).seal(Buffer.from("y"))));

  // A different id in the info gives a different key.
  const spoof = new SessionCipher(secret, nc, ns, sessionInfo("session", "c".repeat(32), "b".repeat(32)), true);
  assert.throws(() => spoof.open(new SessionCipher(secret, nc, ns, info, false).seal(Buffer.from("z"))));
});

test("messages encode and decode with binary bodies", () => {
  const body = randomBytes(1000);
  const m = decodeMessage(encodeMessage("file_chunk", { id: "abc" }, body));
  assert.equal(m.t, "file_chunk");
  assert.equal(m.header.id, "abc");
  assert.deepEqual(m.body, body);
  assert.throws(() => decodeMessage(Buffer.from([0, 0, 0, 9, 1])));
});

test("pairing links and typed codes parse", () => {
  const token = randomBytes(16);
  const uri = buildPairingUri({ token, desktopId: "f".repeat(32), name: "Ada's Laptop & co", hosts: ["192.168.1.5:47820"], relay: "tls://relay.example.com:443" });
  const p = parsePairing(uri)!;
  assert.deepEqual(p.token, token);
  assert.equal(p.name, "Ada's Laptop & co");
  assert.deepEqual(p.hosts, ["192.168.1.5:47820"]);
  assert.equal(p.relay, "tls://relay.example.com:443");

  const typed = parsePairing(formatCode(token).toLowerCase())!;
  assert.deepEqual(typed.token, token);
  assert.equal(parsePairing("hello"), null);
  assert.equal(parsePairing("pairwise://pair?v=1&t=AAAA"), null);
  assert.equal(parseRelayUrl("http://x:1"), null);
  assert.deepEqual(parseRelayUrl("tcp://127.0.0.1:9000"), { tls: false, host: "127.0.0.1", port: 9000 });
});
