// End-to-end: a real DesktopNode and a PhoneLink talking over localhost TCP, UDP and the relay.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DesktopNode } from "../src/node/desktop.ts";
import { createRelayServer } from "../src/node/relay-server.ts";
import { nodePhoneTransport } from "../src/node/transport.ts";
import { PhoneLink, type PairedDesktop, type PhoneTransport } from "../src/phone.ts";
import { FileReceiver, sendFile } from "../src/transfer.ts";
import { HandshakeError } from "../src/handshake.ts";
import { newDeviceId, randomBytes, formatCode } from "../src/crypto.ts";
import type { Connection } from "../src/connection.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pairwise-test-"));
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let portBase = 48100 + Math.floor(Math.random() * 400) * 4;
function ports() {
  const p = portBase;
  portBase += 4;
  return { tcp: p, probe: p + 1, relay: p + 2 };
}

async function makeDesktop(name: string, p: ReturnType<typeof ports>, relay?: string) {
  const dir = fs.mkdtempSync(path.join(tmp, "desk-"));
  const d = new DesktopNode({
    dataDir: dir, name, port: p.tcp, probePort: p.probe, bindHost: "127.0.0.1", advertiseHosts: ["127.0.0.1"],
    downloadDir: path.join(dir, "Downloads"), idleTimeoutMs: 5000,
  });
  if (relay) d.setRelay(relay);
  await d.start();
  cleanups.push(() => d.stop());
  return d;
}

function makePhone(p: ReturnType<typeof ports>, transport?: PhoneTransport) {
  const link = new PhoneLink(
    { id: newDeviceId(), name: "Test Pixel", platform: "test" },
    transport ?? nodePhoneTransport(["127.0.0.1"], p.probe),
    { lanTimeoutMs: 1000, probeTimeoutMs: 400, relayMatchTimeoutMs: 2000, pingIntervalMs: 500, idleTimeoutMs: 5000, maxBackoffMs: 500 },
  );
  cleanups.push(() => link.stop());
  return link;
}

function waitFor<T>(register: (resolve: (v: T) => void) => void, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    register((v) => { clearTimeout(t); resolve(v); });
  });
}

async function connected(link: PhoneLink): Promise<Connection> {
  if (link.state.kind === "connected") return link.connection!;
  return waitFor<Connection>((res) => link.on("connection", res));
}

test("pair by QR link on the LAN, then clipboard both ways", async () => {
  const p = ports();
  const desk = await makeDesktop("Desk A", p);
  const phone = makePhone(p);
  const session = desk.startPairing();
  const pairedEvt = waitFor((res) => desk.on("paired", res));
  const d = await phone.pair(session.uri);
  await pairedEvt;
  assert.equal(d.id, desk.id);
  assert.equal(d.name, "Desk A");
  assert.equal(desk.devices().length, 1);
  assert.equal(desk.isPairing, false, "token is one-time");
  assert.equal(phone.state.kind, "connected");

  const gotOnDesk = waitFor<string>((res) => desk.on("clipText", (t) => res(t)));
  await phone.sendText("from phone");
  assert.equal(await gotOnDesk, "from phone");

  const conn = phone.connection!;
  const gotOnPhone = waitFor<string>((res) => conn.on("message", (m) => m.t === "clip_text" && res(m.body.toString())));
  await desk.sendText("from desktop");
  assert.equal(await gotOnPhone, "from desktop");
});

test("typed code pairs through the LAN probe, and reconnects after a drop", async () => {
  const p = ports();
  const desk = await makeDesktop("Desk B", p);
  const phone = makePhone(p);
  const { code } = desk.startPairing();
  const d = await phone.pair(code);
  assert.deepEqual(d.hosts, [`127.0.0.1:${p.tcp}`]);

  phone.start(d);
  await connected(phone);
  const reconnected = waitFor<Connection>((res) => phone.on("connection", res));
  for (const c of desk.connections()) c.close("simulated drop");
  const again = await reconnected;
  assert.equal(again.route, "lan");
});

test("saved address stale: probe finds the desktop and updates the record", async () => {
  const p = ports();
  const desk = await makeDesktop("Desk C", p);
  const phone = makePhone(p);
  const d = await phone.pair(desk.startPairing().uri);
  phone.stop();
  const stale: PairedDesktop = { ...d, hosts: ["127.0.0.1:1"] };
  const phone2 = new PhoneLink(
    { id: (phone as any).me.id, name: "Test Pixel", platform: "test" },
    nodePhoneTransport(["127.0.0.1"], p.probe),
    { lanTimeoutMs: 500, probeTimeoutMs: 400 },
  );
  cleanups.push(() => phone2.stop());
  const updated = waitFor<PairedDesktop>((res) => phone2.on("desktopUpdated", res));
  phone2.start(stale);
  await connected(phone2);
  assert.equal((await updated).hosts[0], `127.0.0.1:${p.tcp}`);
});

test("wrong code, expired code and revoked phone are refused", async () => {
  const p = ports();
  const desk = await makeDesktop("Desk D", p);
  const phone = makePhone(p);

  const real = desk.startPairing();
  const bogus = real.uri.replace(/t=[A-Z2-7]+/, `t=${formatCode(randomBytes(16)).replace(/-/g, "")}`);
  await assert.rejects(phone.pair(bogus), (e: any) => e instanceof HandshakeError && e.code === "bad_key");

  desk.cancelPairing();
  await assert.rejects(phone.pair(real.uri), (e: any) => e instanceof HandshakeError);

  const d = await phone.pair(desk.startPairing().uri);
  const phoneId = desk.devices()[0].id;
  const gone = waitFor((res) => desk.on("disconnected", res));
  desk.revoke(phoneId);
  await gone;
  await assert.rejects(phone.connectOnce(d), (e: any) => e instanceof HandshakeError && e.code === "unknown_device");
});

test("files both ways with checksum, unsafe names cleaned", async () => {
  const p = ports();
  const desk = await makeDesktop("Desk E", p);
  const phone = makePhone(p);
  await phone.pair(desk.startPairing().uri);
  const conn = phone.connection!;

  // Phone -> desktop: 1.3 MB across several chunks, with a path in the name.
  const data = randomBytes(1_300_000);
  const received = waitFor<string>((res) => desk.on("fileReceived", (p) => res(p)));
  await sendFile(conn, {
    name: "../../etc/evil photo.jpg", size: data.length, mime: "image/jpeg",
    read: async function* () { yield data.subarray(0, 700_000); yield data.subarray(700_000); },
  });
  const savedPath = await received;
  assert.equal(path.basename(savedPath), "evil photo.jpg");
  assert.equal(path.dirname(savedPath), desk.downloadDir);
  assert.deepEqual(fs.readFileSync(savedPath), data);

  // Desktop -> phone.
  const src = path.join(tmp, "report.pdf");
  const pdf = randomBytes(600_000);
  fs.writeFileSync(src, pdf);
  const chunks: Buffer[] = [];
  const phoneGot = waitFor<string>((res) => {
    const rx = new FileReceiver(conn, () => ({
      write: (c) => { chunks.push(c); },
      commit: async () => "phone://Downloads/report.pdf",
      abort: () => {},
    }), { onDone: (_f, loc) => res(loc) });
    conn.on("message", (m) => rx.handle(m));
  });
  await desk.sendFile(src);
  assert.equal(await phoneGot, "phone://Downloads/report.pdf");
  assert.equal(createHash("sha256").update(Buffer.concat(chunks)).digest("hex"), createHash("sha256").update(pdf).digest("hex"));
});

test("away from Wi-Fi: pair and connect through the relay", async () => {
  const p = ports();
  const relay = createRelayServer({ port: p.relay, host: "127.0.0.1", heartbeatMs: 200 });
  await relay.listen();
  cleanups.push(() => relay.close());
  const relayUrl = `tcp://127.0.0.1:${p.relay}`;
  // probePort null: no LAN discovery, so only the relay can work.
  const dir = fs.mkdtempSync(path.join(tmp, "desk-"));
  const desk = new DesktopNode({ dataDir: dir, name: "Desk Relay", port: p.tcp, probePort: null, bindHost: "127.0.0.1", downloadDir: dir });
  desk.setRelay(relayUrl);
  await desk.start();
  cleanups.push(() => desk.stop());

  // A phone transport that can't reach the desktop directly: only the relay port works.
  const nodeT = nodePhoneTransport(["127.0.0.1"], p.probe);
  const offLan: PhoneTransport = {
    connect: (host, port, tls, t) => port === p.relay ? nodeT.connect(host, port, tls, t) : Promise.reject(new Error("unreachable")),
    probe: async () => [],
  };
  const phone = makePhone(p, offLan);
  const session = desk.startPairing();
  await new Promise((r) => setTimeout(r, 300)); // let the desktop's pairing standby reach the relay
  const d = await phone.pair(session.uri);
  assert.equal(d.relay, relayUrl);
  assert.equal(phone.connection!.route, "relay");

  const got = waitFor<string>((res) => desk.on("clipText", (t) => res(t)));
  await phone.sendText("over the relay");
  assert.equal(await got, "over the relay");

  // Reconnect in session mode through the relay after a drop.
  phone.stop();
  await new Promise((r) => setTimeout(r, 300));
  phone.start(d);
  const conn = await connected(phone);
  assert.equal(conn.route, "relay");
  const back = waitFor<string>((res) => conn.on("message", (m) => m.t === "clip_text" && res(m.body.toString())));
  await desk.sendText("relay back");
  assert.equal(await back, "relay back");
  assert.ok(relay.stats.bytes > 0);
});

test("relay rejects a phone whose desktop isn't there", async () => {
  const p = ports();
  const relay = createRelayServer({ port: p.relay, host: "127.0.0.1" });
  await relay.listen();
  cleanups.push(() => relay.close());
  const t = nodePhoneTransport();
  const { FramedSocket } = await import("../src/frame.ts");
  const { joinRelay } = await import("../src/relay-protocol.ts");
  const fsock = new FramedSocket(await t.connect("127.0.0.1", p.relay, false, 1000));
  await assert.rejects(joinRelay(fsock, "a".repeat(64), "phone", 1000), /desktop_offline/);
  fsock.close();
});
