// Pairing links and typed codes.
//
// QR / link:  pairwise://pair?v=2&t=<base32 token>&d=<desktop id>&n=<name>&h=<host:port,...>&r=<relay url>
// Typed code: the token alone, base32 in groups of 4. The phone then finds the desktop with a
//             LAN probe signed with the token, so no address needs typing.

import { Buffer } from "buffer";
import { TOKEN_LEN, base32Decode, base32Encode } from "./crypto.ts";

export interface PairingInfo {
  token: Buffer;
  desktopId?: string;
  name?: string;
  hosts: string[]; // "192.168.1.20:47820"
  relay?: string; // "tls://relay.example.com:443"
}

export function buildPairingUri(p: Required<Omit<PairingInfo, "relay">> & { relay?: string }): string {
  const q: [string, string][] = [["v", "2"], ["t", base32Encode(p.token)], ["d", p.desktopId], ["n", p.name], ["h", p.hosts.join(",")]];
  if (p.relay) q.push(["r", p.relay]);
  return "pairwise://pair?" + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

/** Accepts a full pairwise:// link or a typed code. Returns null if it's neither. */
export function parsePairing(input: string): PairingInfo | null {
  const s = input.trim();
  if (s.toLowerCase().startsWith("pairwise://")) {
    // Parsed by hand: React Native's URLSearchParams is incomplete on some versions.
    const fields = new Map<string, string>();
    for (const part of s.slice(s.indexOf("?") + 1).split("&")) {
      const i = part.indexOf("=");
      if (i > 0) fields.set(part.slice(0, i), safeDecode(part.slice(i + 1)));
    }
    const q = { get: (k: string) => fields.get(k) ?? null };
    if (q.get("v") !== "2") return null;
    const token = base32Decode(q.get("t") ?? "");
    if (token.length !== TOKEN_LEN) return null;
    const desktopId = q.get("d") ?? undefined;
    if (desktopId && !/^[0-9a-f]{32}$/.test(desktopId)) return null;
    return {
      token,
      desktopId,
      name: q.get("n") ?? undefined,
      hosts: (q.get("h") ?? "").split(",").filter((h) => /^[\w.:\[\]-]+:\d+$/.test(h)),
      relay: parseRelayUrl(q.get("r") ?? "") ? q.get("r")! : undefined,
    };
  }
  const token = base32Decode(s);
  if (token.length !== TOKEN_LEN || s.replace(/[^A-Za-z2-7]/g, "").length !== 26) return null;
  return { token, hosts: [] };
}

export interface RelayAddress {
  tls: boolean;
  host: string;
  port: number;
}

/** "tls://host:port" or "tcp://host:port" (tcp only for testing or a trusted network). */
export function parseRelayUrl(url: string): RelayAddress | null {
  const m = /^(tls|tcp):\/\/([\w.-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(url.trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  return { tls: m[1] === "tls", host: m[2].replace(/^\[|\]$/g, ""), port };
}

export function splitHostPort(hp: string): { host: string; port: number } {
  const i = hp.lastIndexOf(":");
  return { host: hp.slice(0, i).replace(/^\[|\]$/g, ""), port: Number(hp.slice(i + 1)) };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return "";
  }
}
