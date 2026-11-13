import { useEffect, useState } from "react";
import {
  ActivityIndicator, Alert, AppState as RNAppState, PermissionsAndroid, Platform, Pressable, ScrollView,
  StyleSheet, Switch, Text, TextInput, View, useColorScheme,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as DocumentPicker from "expo-document-picker";
import * as Linking from "expo-linking";
import Native from "../modules/pairwise-native";
import { manager, type Activity, type AppState } from "./link";

const light = {
  surface: "#f3f5f8", panel: "#ffffff", ink: "#18212e", quiet: "#5b6676", rule: "#dde2ea",
  action: "#2747d9", actionInk: "#ffffff", live: "#13865b", warn: "#b4540a",
};
const dark = {
  surface: "#12171f", panel: "#1a212c", ink: "#e8edf4", quiet: "#9aa6b6", rule: "#2b3443",
  action: "#7b93ff", actionInk: "#0d1220", live: "#4cc795", warn: "#f0a35e",
};
type Palette = typeof light;

function useManager(): AppState {
  const [s, setS] = useState(manager.state);
  useEffect(() => {
    const off = manager.on("change", setS);
    void manager.init();
    return off;
  }, []);
  return s;
}

export default function App() {
  const c = useColorScheme() === "dark" ? dark : light;
  const s = useManager();
  const url = Linking.useURL();

  // Scanning the desktop's QR code with the camera app opens pairwise://pair links here.
  useEffect(() => {
    if (!url?.startsWith("pairwise://pair") || !s.ready) return;
    if (s.desktop) {
      Alert.alert("Pair with a new computer?", `This replaces ${s.desktop.name}.`, [
        { text: "Cancel", style: "cancel" },
        { text: "Pair", onPress: () => void manager.unpair().then(() => manager.pair(url)).catch((e) => Alert.alert("Not paired", e.message)) },
      ]);
    } else {
      void manager.pair(url).catch((e) => Alert.alert("Not paired", e.message));
    }
  }, [url, s.ready]);

  useEffect(() => {
    if (Platform.OS === "android" && Number(Platform.Version) >= 33) {
      void PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS" as any);
    }
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: c.surface }]}>
      <StatusBar style="auto" />
      {!s.ready ? (
        <ActivityIndicator style={{ marginTop: 120 }} color={c.action} />
      ) : s.desktop ? (
        <Home s={s} c={c} />
      ) : (
        <Pair c={c} />
      )}
    </View>
  );
}

/** Phone and computer joined by a wire: solid on Wi-Fi, dashed through the relay, broken when apart. */
function LinkArt({ route, c }: { route: "lan" | "relay" | null; c: Palette }) {
  const dashes = route === "lan" ? 1 : 9;
  const color = route ? c.live : c.quiet;
  return (
    <View style={styles.art} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.phone, { borderColor: c.ink }]}>
        <View style={[styles.phoneBar, { backgroundColor: c.ink }]} />
      </View>
      <View style={styles.wire}>
        {Array.from({ length: dashes }, (_, i) => (
          <View key={i} style={[styles.dash, { backgroundColor: color, flex: route === "lan" ? 1 : 0, width: route === "relay" ? 14 : 4 }]} />
        ))}
        {!route && <View style={[styles.break, { backgroundColor: c.quiet }]} />}
      </View>
      <View>
        <View style={[styles.screen, { borderColor: c.ink }]} />
        <View style={[styles.base, { backgroundColor: c.ink }]} />
      </View>
    </View>
  );
}

function Button({ label, onPress, c, kind = "primary", disabled, busy }: {
  label: string; onPress: () => void; c: Palette; kind?: "primary" | "plain" | "danger"; disabled?: boolean; busy?: boolean;
}) {
  const primary = kind === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? { backgroundColor: c.action } : { borderColor: c.rule, borderWidth: 1 },
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      {busy ? <ActivityIndicator color={primary ? c.actionInk : c.action} /> : (
        <Text style={[styles.buttonText, { color: primary ? c.actionInk : kind === "danger" ? c.warn : c.action }]}>{label}</Text>
      )}
    </Pressable>
  );
}

function Pair({ c }: { c: Palette }) {
  const [typing, setTyping] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(input: string | null) {
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      await manager.pair(input);
    } catch (e: any) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <LinkArt route={null} c={c} />
      <Text style={[styles.h1, { color: c.ink }]}>Pair with your computer</Text>
      <Text style={[styles.body, { color: c.quiet }]}>
        On your computer, open Pairwise and choose Pair a phone. Then scan the code it shows.
      </Text>
      <View style={styles.stack}>
        <Button c={c} label="Scan the QR code" busy={busy && !typing} disabled={busy} onPress={() => void Native.scanQr().then(run, (e) => setError(e.message))} />
        {!typing && <Button c={c} kind="plain" label="Type a code instead" disabled={busy} onPress={() => setTyping(true)} />}
      </View>
      {typing && (
        <View style={[styles.panel, { backgroundColor: c.panel, borderColor: c.rule }]}>
          <Text style={[styles.label, { color: c.ink }]}>Pairing code</Text>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="ABCD-EFGH-…"
            placeholderTextColor={c.quiet}
            autoCapitalize="characters"
            autoCorrect={false}
            style={[styles.input, { color: c.ink, borderColor: c.rule, backgroundColor: c.surface }]}
            onSubmitEditing={() => void run(code)}
          />
          <Text style={[styles.small, { color: c.quiet }]}>Your phone and computer need to be on the same Wi-Fi for a typed code.</Text>
          <Button c={c} label="Pair" busy={busy} disabled={code.replace(/[^A-Za-z2-7]/g, "").length < 26} onPress={() => void run(code)} />
        </View>
      )}
      {error && <Text style={[styles.body, { color: c.warn }]} accessibilityLiveRegion="polite">{error}</Text>}
    </ScrollView>
  );
}

function friendly(e: any): string {
  switch (e?.code) {
    case "bad_key": return "That code didn't match. Check it on your computer, or show a new one.";
    case "not_pairing": return "That code has expired. Choose Pair a phone on your computer again.";
    case "not_found": return "Couldn't find your computer. Make sure both are on the same Wi-Fi and Pairwise is open on the computer.";
    case "bad_code": return "That isn't a Pairwise code. Scan the code in the Pairwise window on your computer.";
    case "version": return "Update Pairwise on both devices, then try again.";
    default: return e?.message ?? "Pairing didn't work. Try again.";
  }
}

function Home({ s, c }: { s: AppState; c: Palette }) {
  const [sending, setSending] = useState(false);
  const [batteryOk, setBatteryOk] = useState(() => Native.isIgnoringBatteryOptimizations());
  const d = s.desktop!;
  const route = s.link.kind === "connected" ? s.link.route : null;

  useEffect(() => {
    const sub = RNAppState.addEventListener("change", (st) => {
      if (st === "active") setBatteryOk(Native.isIgnoringBatteryOptimizations());
    });
    return () => sub.remove();
  }, []);

  const headline = route ? `Connected to ${d.name}` : `Looking for ${d.name}`;
  const sub = route === "relay"
    ? "Through your relay. Large files are faster on the same Wi-Fi."
    : route === "lan"
      ? "On this Wi-Fi network."
      : d.relay
        ? "Pairwise keeps trying on Wi-Fi and through your relay."
        : "Make sure Pairwise is running on your computer and you're on the same Wi-Fi.";

  async function act(fn: () => Promise<void>) {
    setSending(true);
    try {
      await fn();
    } catch (e: any) {
      Alert.alert("Not sent", e.message);
    } finally {
      setSending(false);
    }
  }

  async function pickFiles() {
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: false });
    if (r.canceled) return;
    await manager.sendFiles(r.assets.map((a) => ({ uri: a.uri, name: a.name, size: a.size ?? -1, mime: a.mimeType ?? null })));
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <LinkArt route={route} c={c} />
      <Text style={[styles.h1, { color: c.ink }]} accessibilityLiveRegion="polite">{headline}</Text>
      <Text style={[styles.body, { color: c.quiet }]}>{sub}</Text>

      <View style={styles.row}>
        <View style={{ flex: 1 }}><Button c={c} label="Send clipboard" busy={sending} onPress={() => void act(() => manager.sendClipboard())} /></View>
        <View style={{ flex: 1 }}><Button c={c} kind="plain" label="Send files" disabled={sending} onPress={() => void act(pickFiles)} /></View>
      </View>

      {s.transfer && (
        <View style={[styles.panel, { backgroundColor: c.panel, borderColor: c.rule }]}>
          <Text style={[styles.body, { color: c.ink, marginBottom: 8 }]} numberOfLines={1}>
            {s.transfer.direction === "in" ? "Receiving" : "Sending"} {s.transfer.name}
          </Text>
          <View style={[styles.track, { backgroundColor: c.rule }]}>
            <View style={[styles.fill, { backgroundColor: c.action, width: `${s.transfer.size > 0 ? Math.min(100, (100 * s.transfer.done) / s.transfer.size) : 50}%` }]} />
          </View>
        </View>
      )}

      <View style={[styles.panel, { backgroundColor: c.panel, borderColor: c.rule }]}>
        <Text style={[styles.h2, { color: c.ink }]}>Recent</Text>
        {s.activity.length === 0 ? (
          <Text style={[styles.body, { color: c.quiet, marginBottom: 0 }]}>
            Copy something on your computer and it appears here, ready to paste. To send from this phone, use Share › Computer or the Send to computer tile.
          </Text>
        ) : (
          s.activity.map((a, i) => <ActivityRow key={a.id} a={a} c={c} first={i === 0} />)
        )}
      </View>

      <View style={[styles.panel, { backgroundColor: c.panel, borderColor: c.rule }]}>
        <Text style={[styles.h2, { color: c.ink }]}>Settings</Text>
        <View style={styles.setting}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.label, { color: c.ink }]}>Copy what your computer sends</Text>
            <Text style={[styles.small, { color: c.quiet }]}>Text and images copied on the computer go straight to this phone's clipboard.</Text>
          </View>
          <Switch value={s.copyIncoming} onValueChange={(v) => void manager.setCopyIncoming(v)} trackColor={{ true: c.action }} />
        </View>
        {!batteryOk && (
          <View style={[styles.setting, { borderTopColor: c.rule, borderTopWidth: StyleSheet.hairlineWidth }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.label, { color: c.ink }]}>Stay connected in the background</Text>
              <Text style={[styles.small, { color: c.quiet }]}>Without this, Android may cut the connection when the screen is off.</Text>
            </View>
            <Button c={c} kind="plain" label="Allow" onPress={() => Native.requestIgnoreBatteryOptimizations()} />
          </View>
        )}
        <View style={[styles.setting, { borderTopColor: c.rule, borderTopWidth: StyleSheet.hairlineWidth }]}>
          <Text style={[styles.small, { color: c.quiet, flex: 1 }]}>
            Paired with {d.name}{d.relay ? ", with a relay for when you're away" : ""}.
          </Text>
          <Button c={c} kind="danger" label="Unpair" onPress={() => Alert.alert(`Unpair from ${d.name}?`, "You'll need to scan a new code to connect again.", [
            { text: "Cancel", style: "cancel" },
            { text: "Unpair", style: "destructive", onPress: () => void manager.unpair() },
          ])} />
        </View>
      </View>
    </ScrollView>
  );
}

function ActivityRow({ a, c, first }: { a: Activity; c: Palette; first: boolean }) {
  const time = new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <View style={[styles.activity, !first && { borderTopColor: c.rule, borderTopWidth: StyleSheet.hairlineWidth }]}>
      <Text style={[styles.arrow, { color: a.ok ? c.quiet : c.warn }]} accessibilityLabel={a.direction === "in" ? "From computer" : "To computer"}>
        {a.direction === "in" ? "↓" : "↑"}
      </Text>
      <Text style={[styles.body, { color: a.ok ? c.ink : c.warn, flex: 1, marginBottom: 0 }]} numberOfLines={2}>{a.label}</Text>
      <Text style={[styles.small, { color: c.quiet }]}>{time}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { padding: 20, paddingTop: 56, gap: 14 },
  art: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 6, maxWidth: 300 },
  phone: { width: 26, height: 44, borderWidth: 2.5, borderRadius: 6, alignItems: "center", justifyContent: "flex-end", paddingBottom: 5 },
  phoneBar: { width: 8, height: 2.5, borderRadius: 2 },
  wire: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 20 },
  dash: { height: 3, borderRadius: 2 },
  break: { position: "absolute", left: "48%", width: 3, height: 20, borderRadius: 2, transform: [{ rotate: "-30deg" }] },
  screen: { width: 44, height: 30, borderWidth: 2.5, borderRadius: 4 },
  base: { width: 56, height: 2.5, borderRadius: 2, marginTop: 5, marginLeft: -6 },
  h1: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  h2: { fontSize: 15, fontWeight: "700", marginBottom: 8 },
  body: { fontSize: 15, lineHeight: 21, marginBottom: 2 },
  label: { fontSize: 15, fontWeight: "600" },
  small: { fontSize: 13, lineHeight: 18 },
  stack: { gap: 10, marginTop: 4 },
  row: { flexDirection: "row", gap: 10 },
  button: { minHeight: 46, borderRadius: 10, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 15, fontWeight: "600" },
  panel: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 8 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 17, letterSpacing: 1, fontFamily: Platform.select({ android: "monospace" }) },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
  activity: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  arrow: { fontSize: 16, width: 16, textAlign: "center" },
  setting: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
});
