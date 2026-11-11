#!/usr/bin/env node
// Pairwise relay server. Usage:
//   pairwise-relay --port 443 --tls-cert fullchain.pem --tls-key privkey.pem
//   pairwise-relay --port 9443 --insecure        (plain TCP: testing or behind a TLS proxy)

import * as fs from "node:fs";
import { createRelayServer } from "@pairwise/core/node";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : process.env[`PAIRWISE_${name.toUpperCase().replace(/-/g, "_")}`];
}

const port = Number(arg("port") ?? 9443);
const certPath = arg("tls-cert");
const keyPath = arg("tls-key");
const insecure = process.argv.includes("--insecure") || process.env.PAIRWISE_INSECURE === "1";

if (!insecure && !(certPath && keyPath)) {
  console.error("pairwise-relay: pass --tls-cert and --tls-key (or --insecure for plain TCP).");
  process.exit(2);
}

const relay = createRelayServer({
  port,
  host: arg("host"),
  tls: insecure ? undefined : { cert: fs.readFileSync(certPath!), key: fs.readFileSync(keyPath!) },
  maxRooms: Number(arg("max-rooms") ?? 20000),
  maxPerIp: Number(arg("max-per-ip") ?? 64),
  log: (l) => console.log(new Date().toISOString(), l),
});

const bound = await relay.listen();
console.log(`pairwise-relay listening on ${arg("host") ?? "0.0.0.0"}:${bound} (${insecure ? "plain TCP" : "TLS"})`);

setInterval(() => {
  const s = relay.stats;
  console.log(`${new Date().toISOString()} waiting=${s.waiting} pipes=${s.pipes} bytes=${s.bytes}`);
}, 10 * 60_000).unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await relay.close();
    process.exit(0);
  });
}
