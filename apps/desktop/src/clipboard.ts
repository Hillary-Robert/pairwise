// Watches the system clipboard (Electron has no change event, so it polls) and writes
// incoming items without echoing them back to the phone.

import { clipboard, nativeImage } from "electron";
import { createHash } from "node:crypto";

export type ClipItem = { kind: "text"; text: string } | { kind: "image"; png: Buffer };

// Password managers mark secrets with these; such copies are never sent.
const CONCEALED: Record<string, string[]> = {
  darwin: ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType"],
  win32: ["ExcludeClipboardContentFromMonitorProcessing"],
  linux: ["x-kde-passwordManagerHint"],
};

const MAX_IMAGE = 6 * 1024 * 1024;

export class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null;
  private lastText = "";
  private lastImage = "";
  private readonly onChange: (item: ClipItem) => void;

  constructor(onChange: (item: ClipItem) => void) {
    this.onChange = onChange;
  }

  start(intervalMs = 500) {
    // Whatever is on the clipboard at launch isn't a new copy.
    this.lastText = clipboard.readText();
    this.lastImage = this.imageHash();
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Puts an item from the phone on the clipboard, and remembers it so it isn't sent back. */
  write(item: ClipItem) {
    if (item.kind === "text") {
      this.lastText = item.text;
      clipboard.writeText(item.text);
    } else {
      const img = nativeImage.createFromBuffer(item.png);
      if (img.isEmpty()) return;
      clipboard.writeImage(img);
      this.lastImage = this.imageHash();
      this.lastText = clipboard.readText();
    }
  }

  private concealed(): boolean {
    return (CONCEALED[process.platform] ?? []).some((f) => {
      try {
        return clipboard.has(f) || clipboard.readBuffer(f).length > 0;
      } catch {
        return false;
      }
    });
  }

  private imageHash(): string {
    const img = clipboard.readImage();
    if (img.isEmpty()) return "";
    return createHash("sha256").update(img.toBitmap()).digest("hex");
  }

  private poll() {
    const text = clipboard.readText();
    if (text && text !== this.lastText) {
      this.lastText = text;
      if (!this.concealed()) this.onChange({ kind: "text", text });
      return;
    }
    if (text) return; // text copies win over any image representation
    const hash = this.imageHash();
    if (hash && hash !== this.lastImage) {
      this.lastImage = hash;
      if (this.concealed()) return;
      const png = clipboard.readImage().toPNG();
      if (png.length <= MAX_IMAGE) this.onChange({ kind: "image", png });
    }
  }
}
