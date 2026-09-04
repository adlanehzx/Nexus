import { useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { router } from "expo-router";
import { useNexus } from "../lib/nexus.js";
import { theme } from "../theme/index.js";

/**
 * Réglages et session.
 *
 * Peu de choses, volontairement. Ce qui s'y trouve touche à la sécurité — la
 * session, l'enregistrement de l'appareil — ou à un choix que l'application ne
 * peut pas deviner : lire ou non les réponses à voix haute.
 */
export default function SettingsScreen() {
  const nexus = useNexus();
  const [speakReplies, setSpeakReplies] = useState(nexus.voice.speakRepliesEnabled);

  const confirmSignOut = () => {
    Alert.alert("Se déconnecter ?", "Vos jetons seront effacés de cet appareil.", [
      { text: "Annuler", style: "cancel" },
      {
        text: "Se déconnecter",
        style: "destructive",
        onPress: () => {
          void nexus.signOut().then(() => router.replace("/login"));
        },
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <Section title="Voix">
        <Row
          label="Lire les réponses à voix haute"
          hint="Désactivé par défaut : lire dans un lieu public ce que NEXUS répond est rarement souhaité."
        >
          <Switch
            value={speakReplies}
            onValueChange={(value) => {
              setSpeakReplies(value);
              nexus.voice.setSpeakReplies(value);
            }}
            accessibilityLabel="Lire les réponses à voix haute"
          />
        </Row>
      </Section>

      <Section title="Cet appareil">
        <Text style={styles.value}>
          {nexus.session.deviceId ?? "non enregistré auprès de NEXUS"}
        </Text>
        <Text style={styles.hint}>
          Les jetons de session sont conservés dans le trousseau iOS, chiffrés par le système et
          exclus des sauvegardes iCloud.
        </Text>
      </Section>

      <Section title="Connexion">
        <Row
          label="État"
          hint={`${nexus.state.connection} · ${nexus.state.online ? "en ligne" : "hors ligne"}`}
        >
          <View />
        </Row>
      </Section>

      <Pressable style={styles.signOut} onPress={confirmSignOut} accessibilityRole="button">
        <Text style={styles.signOutText}>Se déconnecter</Text>
      </Pressable>
    </View>
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

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.label}>{label}</Text>
        {hint !== undefined && <Text style={styles.hint}>{hint}</Text>}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.color.background,
    padding: theme.space(4),
    gap: theme.space(6),
  },
  section: { gap: theme.space(2) },
  sectionTitle: {
    color: theme.color.textFaint,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space(4),
  },
  rowText: { flex: 1, gap: theme.space(1) },
  label: { color: theme.color.text, fontSize: 15 },
  value: { color: theme.color.text, fontSize: 14, fontVariant: ["tabular-nums"] },
  hint: { color: theme.color.textMuted, fontSize: 12, lineHeight: 17 },
  signOut: {
    marginTop: "auto",
    borderWidth: 1,
    borderColor: theme.color.danger,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space(4),
    alignItems: "center",
  },
  signOutText: { color: theme.color.danger, fontSize: 15, fontWeight: "600" },
});
