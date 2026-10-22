import { useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { router } from "expo-router";
import { useNexus } from "../lib/nexus.js";
import { theme } from "../theme/index.js";

/**
 * Settings and session management.
 *
 * Focuses on security (session, device identity) and accessibility preferences (voice read aloud).
 */
export default function SettingsScreen() {
  const nexus = useNexus();
  const [speakReplies, setSpeakReplies] = useState(nexus.voice.speakRepliesEnabled);

  const confirmSignOut = () => {
    Alert.alert("Sign out?", "Your session tokens will be removed from this device.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          void nexus.signOut().then(() => router.replace("/login"));
        },
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <Section title="Voice">
        <Row
          label="Read responses aloud"
          hint="Disabled by default: reading answers aloud in public places is usually undesirable."
        >
          <Switch
            value={speakReplies}
            onValueChange={(value) => {
              setSpeakReplies(value);
              nexus.voice.setSpeakReplies(value);
            }}
            accessibilityLabel="Read responses aloud"
          />
        </Row>
      </Section>

      <Section title="This device">
        <Text style={styles.value}>{nexus.session.deviceId ?? "not registered with NEXUS"}</Text>
        <Text style={styles.hint}>
          Session tokens are stored in the iOS Keychain, encrypted by the system and excluded from
          iCloud backups.
        </Text>
        {nexus.session.deviceId ? (
          <Pressable
            style={[styles.signOut, { borderColor: theme.color.danger, marginTop: 12 }]}
            onPress={() => {
              Alert.alert(
                "Revoke this device?",
                "Permanently revoke this mobile device from NEXUS. All active sessions will be terminated.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Revoke",
                    style: "destructive",
                    onPress: () => {
                      void nexus.api
                        .revokeDevice(nexus.session.deviceId!)
                        .catch(() => undefined)
                        .finally(() => {
                          void nexus.signOut().then(() => router.replace("/login"));
                        });
                    },
                  },
                ],
              );
            }}
            accessibilityRole="button"
          >
            <Text style={[styles.signOutText, { color: theme.color.danger }]}>
              Revoke this device
            </Text>
          </Pressable>
        ) : null}
      </Section>

      <Section title="Connection">
        <Row
          label="Status"
          hint={`${nexus.state.connection} · ${nexus.state.online ? "online" : "offline"}`}
        >
          <View />
        </Row>
      </Section>

      <Pressable style={styles.signOut} onPress={confirmSignOut} accessibilityRole="button">
        <Text style={styles.signOutText}>Sign out</Text>
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
