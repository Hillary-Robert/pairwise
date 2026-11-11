// The desktop's saved state: its identity, paired phones and their keys, and settings.
// One JSON file, written atomically and readable only by the current user.

import * as fs from "node:fs";
import * as path from "node:path";
import { newDeviceId } from "../crypto.ts";
import type { Platform } from "../handshake.ts";

export interface PairedPhone {
  id: string;
  name: string;
  platform: Platform;
  key: string; // base64
  pairedAt: number;
  lastSeen?: number;
}

export interface DesktopState {
  identity: { id: string; name: string };
  devices: Record<string, PairedPhone>;
  settings: { relay?: string; downloadDir?: string; syncClipboard: boolean };
}

export class DesktopStore {
  readonly file: string;
  state: DesktopState;

  constructor(dataDir: string, defaultName: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, "pairwise.json");
    this.state = this.load() ?? {
      identity: { id: newDeviceId(), name: defaultName },
      devices: {},
      settings: { syncClipboard: true },
    };
    this.save();
  }

  private load(): DesktopState | null {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, "utf8")) as DesktopState;
      if (!/^[0-9a-f]{32}$/.test(s?.identity?.id)) return null;
      s.devices ??= {};
      s.settings ??= { syncClipboard: true };
      return s;
    } catch {
      return null;
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  update(fn: (s: DesktopState) => void) {
    fn(this.state);
    this.save();
  }
}
