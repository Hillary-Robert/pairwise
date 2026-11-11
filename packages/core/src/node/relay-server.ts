// Pairwise relay: matches a phone and a desktop that name the same room, then pipes bytes
// between them. It holds no keys, can't read the traffic, and stores nothing.
//
// Wire: see relay-protocol.ts. Frames are [u32 BE length][JSON]; after {"matched":true}
// the relay stops framing and forwards raw bytes both ways.

import * as net from "node:net";
import * as tls from "node:tls";

export interface RelayOptions {
  port: number;
  host?: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
  maxRooms?: number;
  maxPerIp?: number;
  /** A side may wait this long for its partner before being dropped (it reconnects). */
  maxWaitMs?: number;
  heartbeatMs?: number;
  /** A matched pipe with no traffic for this long is closed. Phones ping every 20 s. */
  pipeIdleMs?: number;
  joinTimeoutMs?: number;
  log?: (line: string) => void;
}

interface Waiting {
  sock: net.Socket;
  role: "phone" | "desktop";
  room: string;
  extra: Buffer;
  timers: NodeJS.Timeout[];
}

export interface RelayStats {
  waiting: number;
  pipes: number;
  bytes: number;
}

export function createRelayServer(o: RelayOptions) {
  const maxRooms = o.maxRooms ?? 20_000;
  const maxPerIp = o.maxPerIp ?? 64;
  const maxWaitMs = o.maxWaitMs ?? 15 * 60_000;
  const heartbeatMs = o.heartbeatMs ?? 30_000;
  const pipeIdleMs = o.pipeIdleMs ?? 10 * 60_000;
  const joinTimeoutMs = o.joinTimeoutMs ?? 10_000;
  const log = o.log ?? (() => {});

  const rooms = new Map<string, Waiting>();
  const perIp = new Map<string, number>();
  const stats: RelayStats = { waiting: 0, pipes: 0, bytes: 0 };

  const onSocket = (sock: net.Socket) => {
    const ip = sock.remoteAddress ?? "?";
    const n = (perIp.get(ip) ?? 0) + 1;
    if (n > maxPerIp) {
      sock.destroy();
      return;
    }
    perIp.set(ip, n);
    sock.once("close", () => {
      const left = (perIp.get(ip) ?? 1) - 1;
      left ? perIp.set(ip, left) : perIp.delete(ip);
    });
    sock.on("error", () => {});
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 30_000);

    let buf = Buffer.alloc(0);
    const joinTimer = setTimeout(() => sock.destroy(), joinTimeoutMs);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 4096) return void sock.destroy();
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len > 1024) return void sock.destroy();
      if (buf.length < 4 + len) return;
      clearTimeout(joinTimer);
      sock.off("data", onData);
      let join: any;
      try {
        join = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      } catch {
        return void sock.destroy();
      }
      onJoin(sock, join, buf.subarray(4 + len));
    };
    sock.on("data", onData);
  };

  function send(sock: net.Socket, obj: unknown) {
    const body = Buffer.from(JSON.stringify(obj));
    const h = Buffer.alloc(4);
    h.writeUInt32BE(body.length, 0);
    sock.write(Buffer.concat([h, body]));
  }

  function refuse(sock: net.Socket, error: string) {
    send(sock, { error });
    sock.end();
  }

  function onJoin(sock: net.Socket, join: any, extra: Buffer) {
    const room = String(join?.room ?? "");
    const role = join?.role;
    if (join?.relay !== 1 || !/^[0-9a-f]{64}$/.test(room) || (role !== "phone" && role !== "desktop")) {
      return refuse(sock, "bad_join");
    }
    const other = rooms.get(room);
    if (other && other.role !== role) {
      rooms.delete(room);
      clearWaiting(other);
      return match(other, { sock, role, room, extra, timers: [] });
    }
    if (other) {
      // Same side joined again (a reconnect): the newer connection wins.
      rooms.delete(room);
      clearWaiting(other);
      other.sock.destroy();
    }
    if (rooms.size >= maxRooms) return refuse(sock, "busy");
    if (role === "phone") {
      // Phones don't wait around: their desktop is either there or not.
      return refuse(sock, "desktop_offline");
    }
    const w: Waiting = { sock, role, room, extra, timers: [] };
    rooms.set(room, w);
    stats.waiting = rooms.size;
    send(sock, { waiting: true });
    w.timers.push(setInterval(() => send(sock, { waiting: true }), heartbeatMs));
    w.timers.push(setTimeout(() => sock.end(), maxWaitMs));
    // A waiting desktop must stay silent; anything else is a protocol error.
    sock.on("data", () => sock.destroy());
    sock.once("close", () => {
      clearWaiting(w);
      if (rooms.get(room) === w) rooms.delete(room);
      stats.waiting = rooms.size;
    });
  }

  function clearWaiting(w: Waiting) {
    for (const t of w.timers) clearTimeout(t);
    w.sock.removeAllListeners("data");
  }

  function match(a: Waiting, b: Waiting) {
    stats.waiting = rooms.size;
    stats.pipes++;
    send(a.sock, { matched: true });
    send(b.sock, { matched: true });
    if (a.extra.length) b.sock.write(a.extra);
    if (b.extra.length) a.sock.write(b.extra);
    let idle: NodeJS.Timeout;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { a.sock.destroy(); b.sock.destroy(); }, pipeIdleMs);
    };
    touch();
    const forward = (from: net.Socket, to: net.Socket) => {
      from.on("data", (chunk: Buffer) => {
        stats.bytes += chunk.length;
        touch();
        if (!to.write(chunk)) {
          from.pause();
          to.once("drain", () => from.resume());
        }
      });
      from.once("close", () => {
        clearTimeout(idle);
        to.end();
        setTimeout(() => to.destroy(), 1000).unref();
      });
    };
    forward(a.sock, b.sock);
    forward(b.sock, a.sock);
    a.sock.once("close", () => { stats.pipes = Math.max(0, stats.pipes - 1); });
    log(`matched room ${a.room.slice(0, 8)}`);
  }

  const server: net.Server = o.tls ? tls.createServer({ cert: o.tls.cert, key: o.tls.key }, onSocket) : net.createServer(onSocket);

  return {
    server,
    stats,
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(o.port, o.host, () => resolve((server.address() as net.AddressInfo).port));
      });
    },
    close(): Promise<void> {
      for (const w of rooms.values()) w.sock.destroy();
      rooms.clear();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
