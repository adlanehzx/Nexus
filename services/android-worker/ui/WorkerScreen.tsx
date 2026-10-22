import { useEffect, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import type { AndroidWorker } from "../src/worker.js";

/**
 * Worker management screen.
 */

interface Props {
  worker: AndroidWorker;
  /** UI refresh interval. */
  refreshMs?: number;
}

interface Snapshot {
  state: string;
  authenticated: boolean;
  sessionId: string | null;
  activeTasks: number;
  grantedCapabilities: string[];
  degraded: boolean;
  battery: { percent: number; charging: boolean; powerSaveMode: boolean };
  availability: { accessibility: boolean; screenshot: boolean; notifications: boolean } | null;
}

export function WorkerScreen({ worker, refreshMs = 2_000 }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    const read = () => {
      setSnapshot(worker.describe() as unknown as Snapshot);
    };

    read();
    const handle = setInterval(read, refreshMs);
    return () => {
      clearInterval(handle);
    };
  }, [worker, refreshMs]);

  if (snapshot === null) {
    return (
      <View style={styles.screen}>
        <Text style={styles.muted}>Starting…</Text>
      </View>
    );
  }

  const availability = snapshot.availability;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <View
          style={[
            styles.orbHalo,
            snapshot.state === "ready" ? styles.orbHaloReady : styles.orbHaloIdle,
          ]}
        >
          <View
            style={[
              styles.orbCore,
              snapshot.state === "ready" ? styles.orbCoreReady : styles.orbCoreIdle,
            ]}
          />
        </View>
        <View style={styles.heroText}>
          <Text style={styles.kicker}>NEXUS CONNECTION</Text>
          <Text style={styles.title}>
            {snapshot.state === "ready" ? "CONNECTED" : formatState(snapshot.state).toUpperCase()}
          </Text>
          <Text style={styles.subtitle}>System agent for this device</Text>
        </View>
      </View>
      <Text style={styles.subtitle}>
        This device executes tasks for NEXUS. It does not display your conversations: those
        remain on the iPhone and computer.
      </Text>

      <Section title="Connection">
        <Row label="State" value={formatState(snapshot.state)} />
        <Row label="Authenticated" value={snapshot.authenticated ? "yes" : "no"} />
        <Row label="Session" value={snapshot.sessionId ?? "—"} />
        <Row label="Active tasks" value={String(snapshot.activeTasks)} />
      </Section>

      <Section title="Health">
        <Row
          label="Battery"
          value={`${String(snapshot.battery.percent)} %${snapshot.battery.charging ? " (charging)" : ""}`}
        />
        <Row
          label="Power save mode"
          value={snapshot.battery.powerSaveMode ? "enabled" : "no"}
        />
        <Row
          label="Availability"
          value={snapshot.degraded ? "degraded — non-essential tasks avoided" : "normal"}
        />
      </Section>

      <Section title="Android Permissions">
        <Permission
          label="Accessibility service"
          granted={availability?.accessibility ?? false}
          unlocks="tap, input, scroll, screenshot"
          howTo="Settings → Accessibility → Installed apps → NEXUS Worker"
          onOpen={() => {
            void Linking.sendIntent("android.settings.ACCESSIBILITY_SETTINGS");
          }}
        />
        <Permission
          label="Notifications"
          granted={availability?.notifications ?? false}
          unlocks="android.notification"
          howTo="Settings → Apps → NEXUS Worker → Notifications"
          onOpen={() => {
            void Linking.openSettings();
          }}
        />
        <Permission
          label="Screenshot"
          granted={availability?.screenshot ?? false}
          unlocks="android.ui.screenshot"
          howTo="Provided by accessibility service, on Android 11 or newer."
        />
      </Section>

      <Section title="Capabilities granted by NEXUS">
        {snapshot.grantedCapabilities.length === 0 ? (
          <Text style={styles.muted}>
            None currently. The core grants them after pairing and device approval.
          </Text>
        ) : (
          snapshot.grantedCapabilities.map((capability) => (
            <Text key={capability} style={styles.capability}>
              • {capability}
            </Text>
          ))
        )}
      </Section>

      <Text style={styles.footer}>
        NEXUS does not continuously monitor your phone: no screen recording, no microphone, no
        camera, no reading of your notifications. Each action corresponds to a task you requested.
      </Text>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function Permission({
  label,
  granted,
  unlocks,
  howTo,
  onOpen,
}: {
  label: string;
  granted: boolean;
  unlocks: string;
  howTo: string;
  onOpen?: () => void;
}) {
  return (
    <View style={styles.permission}>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={granted ? styles.granted : styles.missing}>
          {granted ? "granted" : "missing"}
        </Text>
      </View>

      <Text style={styles.muted}>Unlocks: {unlocks}</Text>

      {!granted && (
        <>
          <Text style={styles.howTo}>{howTo}</Text>
          {onOpen !== undefined && (
            <Pressable style={styles.button} onPress={onOpen}>
              <Text style={styles.buttonText}>Open settings</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

function formatState(state: string): string {
  const labels: Record<string, string> = {
    stopped: "stopped",
    connecting: "connecting…",
    authenticating: "authenticating…",
    registering: "registering…",
    ready: "ready",
    reconnecting: "reconnecting…",
    stopping: "stopping…",
  };
  return labels[state] ?? state;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#070a10" },
  content: { padding: 20, gap: 20 },
  hero: { flexDirection: "row", alignItems: "center", gap: 16, paddingTop: 8 },
  heroText: { flex: 1, gap: 2 },
  kicker: { color: "#64758a", fontSize: 11, letterSpacing: 1.2, fontWeight: "700" },
  title: { color: "#edf5ff", fontSize: 23, fontWeight: "800", letterSpacing: -0.4 },
  subtitle: { color: "#91a1b6", fontSize: 13, lineHeight: 20 },
  orbHalo: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  orbHaloReady: { borderColor: "#7de8ff", backgroundColor: "#102837" },
  orbHaloIdle: { borderColor: "#64758a", backgroundColor: "#121b28" },
  orbCore: { width: 25, height: 25, borderRadius: 13 },
  orbCoreReady: {
    backgroundColor: "#7de8ff",
    shadowColor: "#7de8ff",
    shadowOpacity: 0.8,
    shadowRadius: 12,
    elevation: 6,
  },
  orbCoreIdle: { backgroundColor: "#91a1b6" },
  section: {
    gap: 8,
    padding: 14,
    borderWidth: 1,
    borderColor: "#26364a",
    borderRadius: 16,
    backgroundColor: "#0d131d",
  },
  sectionTitle: {
    color: "#7c869b",
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: "#c3cad6", fontSize: 15 },
  rowValue: { color: "#f2f4f8", fontSize: 15, fontWeight: "500" },
  permission: { paddingVertical: 8, gap: 4 },
  granted: { color: "#4ade80", fontSize: 15, fontWeight: "600" },
  missing: { color: "#fbbf24", fontSize: 15, fontWeight: "600" },
  howTo: { color: "#98a2b3", fontSize: 13, lineHeight: 18 },
  muted: { color: "#6b7280", fontSize: 13 },
  capability: { color: "#c3cad6", fontSize: 14, lineHeight: 20 },
  button: {
    marginTop: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: "#1f2937",
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  buttonText: { color: "#f2f4f8", fontSize: 14, fontWeight: "600" },
  footer: { color: "#6b7280", fontSize: 12, lineHeight: 18, marginTop: 8 },
});
