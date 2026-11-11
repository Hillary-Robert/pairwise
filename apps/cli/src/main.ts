#!/usr/bin/env node
// pairwise: command-line desktop and test phone.
//
//   pairwise desktop [--relay tls://host:443] [--data DIR]     run a headless desktop; prints a pairing link
//   pairwise phone pair <link-or-code> [--data DIR]            pair as a phone and save the desktop
//   pairwise phone send-text "hello" [--data DIR]              send text to the paired desktop
//   pairwise phone send-file ./photo.jpg [--data DIR]          send a file
//   pairwise phone listen [--data DIR]                         print what the desktop sends

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PhoneLink, newDeviceId, sendFile, type PairedDesktop } from "@pairwise/core";
import { DesktopNode, mimeFor, nodePhoneTransport } from "@pairwise/core/node";

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const dataDir = opt("data") ?? path.join(os.homedir(), ".pairwise-cli");
const relay = opt("relay");
const [cmd, sub, value] = argv;

async function desktop() {
  const node = new DesktopNode({ dataDir: path.join(dataDir, "desktop"), log: (l) => console.log(`[pairwise] ${l}`) });
  if (relay !== undefined) node.setRelay(relay || null);
  node.on("paired", (p) => console.log(`paired with ${p.name}`));
  node.on("connected", (c) => console.log(`${c.peerName} connected (${c.route})`));
  node.on("disconnected", (_id, r) => console.log(`phone disconnected: ${r}`));
  node.on("clipText", (t) => console.log(`clipboard from phone: ${t}`));
  node.on("clipImage", (b, mime) => console.log(`image from phone: ${mime}, ${b.length} bytes`));
  node.on("fileReceived", (p) => console.log(`file saved: ${p}`));
  node.on("relayStatus", (s, d) => console.log(`relay: ${s}${d ? ` (${d})` : ""}`));
  await node.start();
  console.log(`${node.name} on port ${node.port}; ${node.devices().length} paired phone(s)`);
  const s = node.startPairing();
  console.log(`\nPairing link (valid 10 min):\n  ${s.uri}\nOr type this code on the phone:\n  ${s.code}\n`);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (line: string) => {
    const text = line.trim();
    if (text) node.sendText(text).then(() => console.log("sent"), (e) => console.log(e.message));
  });
  console.log("Type a line and press Enter to send it to the phone's clipboard.");
}

function phoneState(): { me: { id: string; name: string }; desktop?: PairedDesktop } {
  const f = path.join(dataDir, "phone.json");
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    const s = { me: { id: newDeviceId(), name: `${os.hostname()} (CLI phone)` } };
    savePhone(s);
    return s;
  }
}
function savePhone(s: object) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, "phone.json"), JSON.stringify(s, null, 2), { mode: 0o600 });
}

async function phone() {
  const state = phoneState();
  const link = new PhoneLink({ ...state.me, platform: "test" }, nodePhoneTransport());
  link.on("desktopUpdated", (d) => savePhone({ ...state, desktop: d }));
  if (sub === "pair") {
    const d = await link.pair(value ?? "");
    savePhone({ ...state, desktop: d });
    console.log(`paired with ${d.name} (${link.connection?.route})`);
    link.stop();
    return;
  }
  if (!state.desktop) throw new Error("not paired yet: run `pairwise phone pair <link-or-code>`");
  const conn = await link.connectOnce(state.desktop);
  console.log(`connected to ${conn.peerName} (${conn.route})`);
  if (sub === "send-text") {
    await conn.send("clip_text", {}, Buffer.from(value ?? "", "utf8"));
  } else if (sub === "send-file") {
    const st = fs.statSync(value!);
    await sendFile(conn, { name: path.basename(value!), size: st.size, mime: mimeFor(value!), read: () => fs.createReadStream(value!) });
    console.log("file delivered and verified");
  } else if (sub === "listen") {
    conn.on("message", (m) => console.log(m.t === "clip_text" ? `clipboard: ${m.body.toString()}` : `message: ${m.t}`));
    await new Promise<void>((r) => conn.on("close", (why) => { console.log(`closed: ${why}`); r(); }));
    return;
  } else {
    throw new Error(`unknown command: phone ${sub}`);
  }
  conn.close();
}

try {
  if (cmd === "desktop") await desktop();
  else if (cmd === "phone") await phone();
  else {
    console.log("usage: pairwise desktop [--relay URL] | pairwise phone pair|send-text|send-file|listen");
    process.exit(cmd ? 2 : 0);
  }
} catch (e: any) {
  console.error(`pairwise: ${e?.message ?? e}`);
  process.exit(1);
}
