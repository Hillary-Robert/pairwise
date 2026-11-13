// Phone networking for the shared core: TCP/TLS through react-native-tcp-socket,
// LAN probes through the app's native module.

import { Buffer } from "buffer";
import TcpSocket from "react-native-tcp-socket";
import { PROBE_PORT, type PhoneTransport, type SocketLike } from "@pairwise/core";
import Native from "../modules/pairwise-native";

export const transport: PhoneTransport = {
  connect(host, port, tls, timeoutMs) {
    return new Promise<SocketLike>((resolve, reject) => {
      let settled = false;
      const opts = { host, port };
      const sock: any = tls
        ? TcpSocket.connectTLS({ ...opts, tlsCheckValidity: true }, () => done())
        : TcpSocket.createConnection(opts, () => done());
      const timer = setTimeout(() => fail(new Error(`timed out connecting to ${host}:${port}`)), timeoutMs);
      sock.once("error", (e: Error) => fail(e));
      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.setNoDelay?.(true);
        sock.setKeepAlive?.(true, 30_000);
        resolve(adapt(sock));
      }
      function fail(e: Error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      }
    });
  },

  async probe(payload, timeoutMs) {
    const replies = await Native.probe(new Uint8Array(payload), PROBE_PORT, timeoutMs);
    const out: { host: string; reply: any }[] = [];
    for (const r of replies) {
      try {
        out.push({ host: r.host, reply: JSON.parse(r.reply) });
      } catch {
        // not ours
      }
    }
    return out;
  },
};

/** Wraps a react-native-tcp-socket socket in exactly the surface the core expects. */
function adapt(sock: any): SocketLike {
  let destroyed = false;
  sock.on("close", () => { destroyed = true; });
  return {
    on(event: string, cb: (...a: any[]) => void) {
      if (event === "data") return sock.on("data", (d: any) => cb(Buffer.from(d)));
      return sock.on(event, cb);
    },
    once(event: string, cb: () => void) {
      return sock.once(event, cb);
    },
    write(data: Buffer | Uint8Array, cb?: (err?: Error | null) => void) {
      return sock.write(Buffer.from(data), undefined, cb);
    },
    end() {
      sock.end();
    },
    destroy() {
      destroyed = true;
      sock.destroy();
    },
    get destroyed() {
      return destroyed;
    },
  } as SocketLike;
}
