// Tray app and window. The protocol lives in DesktopNode (@pairwise/core); this file
// connects it to the clipboard, notifications and dialogs.

import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { DesktopNode } from "@pairwise/core/node";
import { ClipboardWatcher } from "./clipboard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");

if (!app.requestSingleInstanceLock()) app.quit();

let node: DesktopNode;
let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let clip: ClipboardWatcher;
let pairing: { uri: string; code: string; expiresAt: number; qr: string } | null = null;
let relayStatus: "off" | "online" | "unreachable" = "off";
const transfers = new Map<string, { name: string; done: number; size: number }>();

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock?.hide();

  node = new DesktopNode({
    dataDir: path.join(app.getPath("userData"), "link"),
    downloadDir: app.getPath("downloads"),
    log: (l) => console.log(`[pairwise] ${l}`),
  });

  clip = new ClipboardWatcher((item) => {
    if (!node.store.state.settings.syncClipboard || !node.connections().length) return;
    const p = item.kind === "text" ? node.sendText(item.text) : node.sendImage(item.png, "image/png");
    p.catch((e) => console.log(`[pairwise] clipboard not sent: ${e.message}`));
  });

  node.on("connected", (c) => { notify(`${c.peerName} connected`, c.route === "relay" ? "Through your relay" : "On this network"); refresh(); });
  node.on("disconnected", () => refresh());
  node.on("paired", (p) => {
    pairing = null;
    notify("Phone paired", `${p.name} can now share with this computer.`);
    refresh();
  });
  node.on("pairingEnded", () => { pairing = null; refresh(); });
  node.on("relayStatus", (s) => { relayStatus = s; refresh(); });
  node.on("clipText", (t) => clip.write({ kind: "text", text: t }));
  node.on("clipImage", (b) => clip.write({ kind: "image", png: b }));
  node.on("fileProgress", (f, n) => { transfers.set(f.id, { name: f.name, done: n, size: f.size }); refresh(); });
  node.on("fileReceived", (filePath, f) => {
    transfers.delete(f.id);
    const n = notify("File received", `${path.basename(filePath)} is in Downloads.`);
    n?.on("click", () => shell.showItemInFolder(filePath));
    refresh();
  });
  node.on("fileFailed", (f, e) => {
    transfers.delete(f.id);
    notify("File not received", `${f.name}: ${e}. Send it again.`);
    refresh();
  });

  await node.start();
  clip.start();
  createTray();
  registerIpc();
  if (!node.devices().length) openWindow();
});

app.on("second-instance", () => openWindow());
app.on("window-all-closed", () => { /* stay in the tray */ });
app.on("before-quit", async () => {
  clip?.stop();
  await node?.stop();
});

function notify(title: string, body: string): Notification | null {
  if (!Notification.isSupported()) return null;
  const n = new Notification({ title, body, silent: true });
  n.show();
  return n;
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(assets, process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Pairwise");
  tray.on("click", () => (process.platform === "darwin" ? tray!.popUpContextMenu() : openWindow()));
  refresh();
}

function statusLine(): string {
  const conns = node.connections();
  if (conns.length) return conns.map((c) => `${c.peerName} (${c.route === "relay" ? "via relay" : "Wi-Fi"})`).join(", ");
  if (!node.devices().length) return "No phone paired";
  return "Waiting for your phone";
}

function refresh() {
  if (tray) {
    const s = node.store.state.settings;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: statusLine(), enabled: false },
      { type: "separator" },
      { label: "Send Files to Phone…", enabled: node.connections().length > 0, click: () => void pickAndSend() },
      { label: "Pair a Phone…", click: () => { void startPairing(); openWindow(); } },
      { label: "Open Pairwise", click: () => openWindow() },
      { type: "separator" },
      { label: "Share Clipboard Automatically", type: "checkbox", checked: s.syncClipboard, click: (i) => setSync(i.checked) },
      { label: "Open at Login", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
      { type: "separator" },
      { label: "Quit Pairwise", role: "quit" },
    ]));
  }
  win?.webContents.send("state", snapshot());
}

function openWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 440,
    height: 640,
    minWidth: 380,
    minHeight: 480,
    title: "Pairwise",
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  void win.loadFile(path.join(here, "renderer", "index.html"));
  win.once("ready-to-show", () => win!.show());
  win.on("closed", () => { win = null; });
  // Links never navigate the window; they open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

function snapshot() {
  const conns = new Map(node.connections().map((c) => [c.peerId, c]));
  return {
    name: node.name,
    phones: node.devices().map((d) => ({
      id: d.id,
      name: d.name,
      lastSeen: d.lastSeen ?? null,
      route: conns.get(d.id)?.route ?? null,
    })),
    pairing,
    settings: {
      syncClipboard: node.store.state.settings.syncClipboard,
      relay: node.store.state.settings.relay ?? "",
      downloadDir: node.downloadDir,
    },
    relayStatus,
    transfers: [...transfers.values()],
  };
}

async function startPairing() {
  const s = node.startPairing();
  const qr = await QRCode.toDataURL(s.uri, { margin: 1, width: 480, errorCorrectionLevel: "M" });
  pairing = { ...s, qr };
  refresh();
}

function setSync(on: boolean) {
  node.store.update((s) => { s.settings.syncClipboard = on; });
  refresh();
}

async function pickAndSend(given?: string[]) {
  let paths: string[] = given ?? [];
  if (!given) {
    const r = await dialog.showOpenDialog({ title: "Send to phone", properties: ["openFile", "multiSelections"] });
    if (r.canceled) return;
    paths = r.filePaths;
  }
  for (const p of paths) {
    const name = path.basename(p);
    try {
      await node.sendFile(p, undefined, (done, size) => {
        transfers.set(`out:${p}`, { name, done, size });
        win?.webContents.send("state", snapshot());
      });
      notify("Sent to phone", name);
    } catch (e: any) {
      notify("Not sent", `${name}: ${e.message}`);
    } finally {
      transfers.delete(`out:${p}`);
      refresh();
    }
  }
}

function registerIpc() {
  ipcMain.handle("state", () => snapshot());
  ipcMain.handle("pair:start", () => startPairing());
  ipcMain.handle("pair:cancel", () => { node.cancelPairing(); });
  ipcMain.handle("phone:unpair", (_e, id: string) => { node.revoke(String(id)); refresh(); });
  ipcMain.handle("settings:sync", (_e, on: boolean) => setSync(Boolean(on)));
  ipcMain.handle("settings:relay", (_e, url: string) => {
    try {
      node.setRelay(String(url).trim() || null);
      refresh();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle("settings:downloads", async () => {
    const r = await dialog.showOpenDialog({ title: "Save received files in", properties: ["openDirectory", "createDirectory"] });
    if (!r.canceled && r.filePaths[0]) {
      node.store.update((s) => { s.settings.downloadDir = r.filePaths[0]; });
      refresh();
    }
  });
  ipcMain.handle("files:send", (_e, paths?: string[]) => pickAndSend(Array.isArray(paths) && paths.length ? paths.map(String) : undefined));
  ipcMain.handle("downloads:open", () => shell.openPath(node.downloadDir));
}
