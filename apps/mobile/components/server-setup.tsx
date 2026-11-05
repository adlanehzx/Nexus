import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useServer } from "../lib/server.js";
import { type Theme, useTheme, useThemedStyles } from "../theme/index.js";
import { KeyboardForm } from "./keyboard-aware.js";
import { NexusOrb } from "./nexus-orb.js";

/**
 * First launch: which NEXUS core?
 *
 * The address is checked against the server before anything else asks for it,
 * so a typo surfaces here rather than as a failed sign-in.
 */
export function ServerSetup({ initial, onDone }: { initial?: string; onDone?: () => void }) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const server = useServer();
  const [address, setAddress] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await server.setUrl(address);
      onDone?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid address.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardForm style={styles.screen} contentStyle={styles.content}>
      <View style={styles.orb}>
        <NexusOrb state={busy ? "executing" : "idle"} size={110} />
      </View>
      <Text style={styles.title}>Connect to your NEXUS</Text>
      <Text style={styles.subtitle}>
        Enter the address of your core, such as nexus-core.example-tailnet.ts.net. Remote addresses
        must use https.
      </Text>
      <TextInput
        style={styles.input}
        value={address}
        onChangeText={setAddress}
        placeholder="https://nexus.example.com"
        placeholderTextColor={theme.color.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        accessibilityLabel="NEXUS server address"
      />
      {error !== undefined && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      <Pressable
        style={[styles.button, (busy || address.trim().length === 0) && styles.buttonBusy]}
        onPress={() => void submit()}
        disabled={busy || address.trim().length === 0}
        accessibilityRole="button"
        accessibilityLabel="Continue"
      >
        {busy ? (
          <ActivityIndicator color={theme.color.textOnAccent} />
        ) : (
          <Text style={styles.buttonText}>Continue</Text>
        )}
      </Pressable>
    </KeyboardForm>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { backgroundColor: theme.color.background },
    content: {
      padding: theme.space(8),
      justifyContent: "center",
      gap: theme.space(5),
    },
    orb: { alignItems: "center", marginBottom: theme.space(4) },
    title: { color: theme.color.text, fontSize: 26, fontWeight: "700" },
    subtitle: { color: theme.color.textMuted, fontSize: 14, lineHeight: 20 },
    input: {
      backgroundColor: theme.color.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.color.border,
      color: theme.color.text,
      fontSize: 16,
      paddingHorizontal: theme.space(6),
      paddingVertical: theme.space(6),
    },
    button: {
      backgroundColor: theme.color.accent,
      borderRadius: theme.radius.lg,
      paddingVertical: theme.space(6),
      alignItems: "center",
    },
    buttonBusy: { opacity: 0.6 },
    buttonText: { color: theme.color.textOnAccent, fontSize: 16, fontWeight: "700" },
    error: { color: theme.color.danger, fontSize: 14 },
  });
