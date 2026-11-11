// The only bridge between the window and the app. The page gets these functions and nothing else.

import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("pairwise", {
  state: () => ipcRenderer.invoke("state"),
  onState: (cb: (s: unknown) => void) => {
    const listener = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.off("state", listener);
  },
  startPairing: () => ipcRenderer.invoke("pair:start"),
  cancelPairing: () => ipcRenderer.invoke("pair:cancel"),
  unpair: (id: string) => ipcRenderer.invoke("phone:unpair", id),
  setSync: (on: boolean) => ipcRenderer.invoke("settings:sync", on),
  setRelay: (url: string) => ipcRenderer.invoke("settings:relay", url),
  chooseDownloads: () => ipcRenderer.invoke("settings:downloads"),
  openDownloads: () => ipcRenderer.invoke("downloads:open"),
  sendFiles: (files?: File[]) => ipcRenderer.invoke("files:send", files?.map((f) => webUtils.getPathForFile(f))),
});
