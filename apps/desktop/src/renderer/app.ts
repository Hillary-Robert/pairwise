"use strict";
// Window script. Talks to the app only through window.pairwise (see preload.cts).

interface Phone { id: string; name: string; lastSeen: number | null; route: "lan" | "relay" | null }
interface State {
  name: string;
  phones: Phone[];
  pairing: { uri: string; code: string; expiresAt: number; qr: string } | null;
  settings: { syncClipboard: boolean; relay: string; downloadDir: string };
  relayStatus: "off" | "online" | "unreachable";
  transfers: { name: string; done: number; size: number }[];
}
interface Api {
  state(): Promise<State>;
  onState(cb: (s: State) => void): () => void;
  startPairing(): Promise<void>;
  cancelPairing(): Promise<void>;
  unpair(id: string): Promise<void>;
  setSync(on: boolean): Promise<void>;
  setRelay(url: string): Promise<{ ok: boolean; error?: string }>;
  chooseDownloads(): Promise<void>;
  openDownloads(): Promise<void>;
  sendFiles(files?: File[]): Promise<void>;
}

const api = (window as unknown as { pairwise: Api }).pairwise;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let state: State | null = null;
let relayDirty = false;

function render(s: State) {
  state = s;
  const live = s.phones.filter((p) => p.route);

  const link = $("link");
  link.dataset.route = live[0]?.route ?? "none";
  if (live.length) {
    $("headline").textContent = `Connected to ${live.map((p) => p.name).join(" and ")}`;
    $("subline").textContent = live[0].route === "relay" ? "Through your relay. Large files are faster on the same Wi-Fi." : "On this Wi-Fi network.";
  } else if (s.phones.length) {
    $("headline").textContent = "Waiting for your phone";
    $("subline").textContent = s.relayStatus === "online"
      ? "Your phone can reach this computer on this Wi-Fi or through the relay."
      : "Make sure both are on the same Wi-Fi, or set up a relay below.";
  } else {
    $("headline").textContent = "Pair your phone to start";
    $("subline").textContent = `This computer appears on your phone as “${s.name}”.`;
  }

  $("pair-panel").hidden = !s.pairing;
  $("pair-start").hidden = Boolean(s.pairing);
  if (s.pairing) {
    $<HTMLImageElement>("qr").src = s.pairing.qr;
    $("code").textContent = s.pairing.code;
  }

  const list = $("phones");
  list.replaceChildren(...s.phones.map((p) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = p.route ? "dot on" : "dot";
    const text = document.createElement("div");
    text.className = "grow";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = p.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = p.route ? (p.route === "relay" ? "Connected through relay" : "Connected on Wi-Fi") : lastSeen(p.lastSeen);
    text.append(name, meta);
    const unpair = document.createElement("button");
    unpair.className = "plain";
    unpair.textContent = "Unpair";
    unpair.addEventListener("click", async () => {
      if (confirm(`Unpair ${p.name}? It will need to scan a new code to connect again.`)) await api.unpair(p.id);
    });
    li.append(dot, text, unpair);
    return li;
  }));
  $("phones-empty").hidden = s.phones.length > 0;

  const drop = $("drop");
  drop.setAttribute("aria-disabled", String(!live.length));
  drop.textContent = live.length ? "Drop files here, or click to choose" : "Connect your phone to send files";
  $("transfers").replaceChildren(...s.transfers.map((t) => {
    const li = document.createElement("li");
    const n = document.createElement("span");
    n.className = "grow";
    n.textContent = t.name;
    const bar = document.createElement("progress");
    if (t.size > 0) { bar.max = t.size; bar.value = t.done; }
    li.append(n, bar);
    return li;
  }));

  $<HTMLInputElement>("sync").checked = s.settings.syncClipboard;
  const dl = $("downloads");
  dl.textContent = s.settings.downloadDir;
  if (!relayDirty) $<HTMLInputElement>("relay").value = s.settings.relay;
  const note = $("relay-note");
  note.classList.toggle("error", s.relayStatus === "unreachable");
  if (s.relayStatus === "unreachable") note.textContent = "Can't reach the relay. Check the address and that the server is running.";
  else if (s.relayStatus === "online") note.textContent = "Relay connected. Phones paired before you added it need to pair once more to use it.";
  else note.textContent = "Optional. Run your own relay to stay connected on mobile data. It only passes encrypted data along.";
}

function lastSeen(t: number | null): string {
  if (!t) return "Not connected yet";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "Seen just now";
  if (mins < 60) return `Seen ${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Seen ${hrs} h ago`;
  return `Seen ${new Date(t).toLocaleDateString()}`;
}

function canSend() {
  return Boolean(state?.phones.some((p) => p.route));
}

$("pair-start").addEventListener("click", () => api.startPairing());
$("pair-cancel").addEventListener("click", () => api.cancelPairing());
$<HTMLInputElement>("sync").addEventListener("change", (e) => api.setSync((e.target as HTMLInputElement).checked));
$("downloads").addEventListener("click", () => api.openDownloads());
$("downloads-change").addEventListener("click", () => api.chooseDownloads());
$("relay").addEventListener("input", () => { relayDirty = true; });
$("relay-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await api.setRelay($<HTMLInputElement>("relay").value);
  relayDirty = false;
  if (!r.ok) {
    const note = $("relay-note");
    note.textContent = r.error ?? "That relay address isn't valid.";
    note.classList.add("error");
  }
});

const drop = $("drop");
drop.addEventListener("click", () => { if (canSend()) void api.sendFiles(); });
drop.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && canSend()) { e.preventDefault(); void api.sendFiles(); } });
drop.addEventListener("dragover", (e) => { e.preventDefault(); if (canSend()) drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length && canSend()) void api.sendFiles(files);
});
// Dropping anywhere else must not navigate the window to the file.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// Keep the expiry countdown fresh while pairing.
setInterval(() => {
  if (!state?.pairing) return;
  const left = Math.max(0, Math.round((state.pairing.expiresAt - Date.now()) / 60000));
  $("pair-left").textContent = left <= 1 ? "about a minute" : `${left} minutes`;
}, 5000);

api.onState(render);
api.state().then(render);
