import { useEffect, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import type { AndroidWorker } from "../src/worker.js";

/**
 * Écran de gestion du worker.
 *
 * **Ce n'est pas l'interface NEXUS.** On ne discute pas avec l'assistant ici :
 * l'iPhone et le portable Windows restent les clients. Cet écran ne sert qu'à
 * répondre à trois questions, dans cet ordre :
 *
 *  1. le téléphone est-il connecté au cœur ?
 *  2. que sait-il faire, ici et maintenant ?
 *  3. que manque-t-il, et comment l'accorder ?
 *
 * La troisième est la plus importante. Un worker Android passe son temps à
 * perdre des capacités — l'utilisateur désactive un service, refuse une
 * permission, redémarre. Un écran qui affiche « indisponible » sans dire où
 * cliquer transforme un réglage de dix secondes en séance de fouille.
 */

interface Props {
  worker: AndroidWorker;
  /** Période de rafraîchissement de l'affichage. */
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
        <Text style={styles.muted}>Démarrage…</Text>
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
            {snapshot.state === "ready" ? "CONNECTED" : frenchState(snapshot.state).toUpperCase()}
          </Text>
          <Text style={styles.subtitle}>Agent système de cet appareil</Text>
        </View>
      </View>
      <Text style={styles.subtitle}>
        Cet appareil exécute des tâches pour NEXUS. Il n'affiche pas vos conversations : elles
        restent sur l'iPhone et l'ordinateur.
      </Text>

      <Section title="Connexion">
        <Row label="État" value={frenchState(snapshot.state)} />
        <Row label="Authentifié" value={snapshot.authenticated ? "oui" : "non"} />
        {/* L'identifiant de session n'ouvre rien : ce n'est pas le jeton. */}
        <Row label="Session" value={snapshot.sessionId ?? "—"} />
        <Row label="Tâches en cours" value={String(snapshot.activeTasks)} />
      </Section>

      <Section title="Santé">
        <Row
          label="Batterie"
          value={`${String(snapshot.battery.percent)} %${snapshot.battery.charging ? " (en charge)" : ""}`}
        />
        <Row
          label="Économie d'énergie"
          value={snapshot.battery.powerSaveMode ? "activée" : "non"}
        />
        <Row
          label="Disponibilité"
          value={snapshot.degraded ? "dégradé — tâches non essentielles évitées" : "normale"}
        />
      </Section>

      <Section title="Autorisations Android">
        <Permission
          label="Service d'accessibilité"
          granted={availability?.accessibility ?? false}
          unlocks="appui, saisie, défilement, capture d'écran"
          howTo="Réglages → Accessibilité → Applications installées → NEXUS Worker"
          onOpen={() => {
            void Linking.sendIntent("android.settings.ACCESSIBILITY_SETTINGS");
          }}
        />
        <Permission
          label="Notifications"
          granted={availability?.notifications ?? false}
          unlocks="android.notification"
          howTo="Réglages → Applications → NEXUS Worker → Notifications"
          onOpen={() => {
            void Linking.openSettings();
          }}
        />
        <Permission
          label="Capture d'écran"
          granted={availability?.screenshot ?? false}
          unlocks="android.ui.screenshot"
          howTo="Fournie par le service d'accessibilité, sur Android 11 ou plus récent."
        />
      </Section>

      <Section title="Capacités accordées par NEXUS">
        {snapshot.grantedCapabilities.length === 0 ? (
          <Text style={styles.muted}>
            Aucune pour l'instant. Le cœur les accorde après l'appairage et l'approbation de
            l'appareil.
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
        NEXUS n'observe pas votre téléphone en continu : ni enregistrement d'écran, ni micro, ni
        caméra, ni lecture de vos notifications. Chaque action correspond à une tâche que vous avez
        demandée.
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

/**
 * Une autorisation, son état, et le chemin exact pour l'accorder.
 *
 * Le bouton mène directement à l'écran système concerné. Le texte du chemin
 * reste affiché malgré tout : sur MIUI, l'arborescence des réglages diffère de
 * l'Android d'origine, et l'intention n'aboutit pas toujours au bon écran.
 */
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
          {granted ? "accordée" : "manquante"}
        </Text>
      </View>

      <Text style={styles.muted}>Débloque : {unlocks}</Text>

      {!granted && (
        <>
          <Text style={styles.howTo}>{howTo}</Text>
          {onOpen !== undefined && (
            <Pressable style={styles.button} onPress={onOpen}>
              <Text style={styles.buttonText}>Ouvrir les réglages</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

function frenchState(state: string): string {
  const labels: Record<string, string> = {
    stopped: "arrêté",
    connecting: "connexion…",
    authenticating: "authentification…",
    registering: "enregistrement…",
    ready: "prêt",
    reconnecting: "reconnexion…",
    stopping: "arrêt…",
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
