// Typed bindings for the app's own Android module (modules/pairwise-native/android).

import { requireNativeModule } from "expo-modules-core";

export interface SharedFile { uri: string; name: string; size: number; mime: string | null }
export type ShareEvent = { kind: "text"; text: string } | { kind: "files"; files: SharedFile[] };
export type PendingEvent =
  | (ShareEvent & { event: "onShare" })
  | { event: "onClipboardCaptured"; text: string };

interface Subscription { remove(): void }

interface PairwiseNativeModule {
  addListener(event: "onShare", cb: (e: ShareEvent) => void): Subscription;
  addListener(event: "onClipboardCaptured", cb: (e: { text: string }) => void): Subscription;
  addListener(event: "onTick", cb: () => void): Subscription;
  addListener(event: "onNetwork", cb: (e: { available: boolean }) => void): Subscription;
  drainPending(): PendingEvent[];
  deviceName(): string;
  startService(title: string, text: string): void;
  stopService(): void;
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): void;
  probe(payload: Uint8Array, port: number, timeoutMs: number): Promise<{ host: string; reply: string }[]>;
  scanQr(): Promise<string | null>;
  beginDownload(name: string, mime: string): string;
  appendDownload(id: string, chunk: Uint8Array): Promise<void>;
  commitDownload(id: string): Promise<string>;
  abortDownload(id: string): Promise<void>;
  fileInfo(uri: string): Promise<{ name: string; size: number; mime: string | null }>;
  readChunk(uri: string, offset: number, length: number): Promise<Uint8Array>;
  deleteFile(uri: string): Promise<void>;
}

export default requireNativeModule<PairwiseNativeModule>("PairwiseNative");
