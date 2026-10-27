import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useNexus } from "../lib/nexus.js";
import { type Theme, useTheme, useThemedStyles } from "../theme/index.js";
import { NexusOrb } from "../components/nexus-orb.js";

/**
 * Sign in screen.
 *
 * Password is exchanged for tokens stored in Keychain via `SessionManager`.
 */
export default function LoginScreen() {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { signIn } = useNexus();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async () => {
    setBusy(true);
    setError(undefined);

    try {
      await signIn(email.trim(), password);
      setPassword("");
      router.replace("/");
    } catch (cause) {
      setPassword("");
      setError(cause instanceof Error ? cause.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.orb}>
        <NexusOrb state={busy ? "executing" : "idle"} size={132} />
      </View>
      <Text style={styles.eyebrow}>PERSONAL INTELLIGENCE OS</Text>
      <Text style={styles.title}>NEXUS</Text>
      <Text style={styles.subtitle}>Your personal intelligence OS, across all your devices.</Text>

      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="Email address"
        placeholderTextColor={theme.color.textFaint}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        accessibilityLabel="Email address"
      />

      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        placeholderTextColor={theme.color.textFaint}
        secureTextEntry
        autoComplete="current-password"
        accessibilityLabel="Password"
      />

      {error !== undefined && <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={[styles.button, busy && styles.buttonBusy]}
        onPress={() => void submit()}
        disabled={busy || email.length === 0 || password.length === 0}
        accessibilityRole="button"
      >
        {busy ? (
          <ActivityIndicator color={theme.color.text} />
        ) : (
          <Text style={styles.buttonText}>Sign in</Text>
        )}
      </Pressable>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.color.background,
      padding: theme.space(8),
      justifyContent: "center",
      gap: theme.space(5),
    },
    orb: { alignItems: "center", marginBottom: theme.space(4) },
    eyebrow: { color: theme.color.textFaint, fontSize: 11, letterSpacing: 1.4, fontWeight: "700" },
    title: { color: theme.color.text, fontSize: 42, fontWeight: "700", letterSpacing: -1.5 },
    subtitle: { color: theme.color.textMuted, fontSize: 15, marginBottom: theme.space(6) },
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
      marginTop: theme.space(4),
    },
    buttonBusy: { opacity: 0.7 },
    buttonText: { color: theme.color.background, fontSize: 16, fontWeight: "700" },
    error: { color: theme.color.danger, fontSize: 14 },
  });
