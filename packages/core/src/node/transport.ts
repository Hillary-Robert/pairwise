// Node implementations of sockets and LAN probing, used by the desktop and the test phone.

import { Buffer } from "node:buffer";
import * as dgram from "node:dgram";
import * as net from "node:net";
import * as os from "node:os";
import * as tls from "node:tls";
import type { PhoneTransport } from "../phone.ts";
import type { SocketLike } from "../frame.ts";
import { PROBE_PORT } from "../phone.ts";

export function connectTcp(host: string, port: number, useTls: boolean, timeoutMs: number): Promise<SocketLike> {
  return new Promise((resolve, reject) => {
    const sock: net.Socket = useTls
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timed out connecting to ${host}:${port}`));
    }, timeoutMs);
    sock.once(useTls ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 30_000);
      resolve(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** IPv4 broadcast addresses of every active LAN interface. */
export function broadcastAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const ip = a.address.split(".").map(Number);
      const mask = a.netmask.split(".").map(Number);
      out.push(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join("."));
    }
  }
  return out.length ? out : ["255.255.255.255"];
}

/** Non-internal IPv4 addresses, for the pairing QR code. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

export function nodePhoneTransport(probeTargets: string[] = broadcastAddresses(), probePort = PROBE_PORT): PhoneTransport {
  return {
    connect: connectTcp,
    probe(payload, timeoutMs) {
      return new Promise((resolve) => {
        const sock = dgram.createSocket("udp4");
        const replies: { host: string; reply: any }[] = [];
        sock.on("message", (msg, rinfo) => {
          try {
            replies.push({ host: rinfo.address, reply: JSON.parse(msg.toString("utf8")) });
          } catch { /* ignore junk */ }
        });
        sock.on("error", () => { /* treated as no replies */ });
        sock.bind(0, () => {
          sock.setBroadcast(true);
          for (const t of probeTargets) sock.send(payload, probePort, t);
        });
        setTimeout(() => { sock.close(); resolve(replies); }, timeoutMs);
      });
    },
  };
}

export { Buffer };
