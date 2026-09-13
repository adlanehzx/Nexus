import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useNexus } from "../lib/nexus.js";
import { theme } from "../theme/index.js";
import { NexusOrb } from "../components/nexus-orb.js";

/**
 * Écran de connexion.
 *
 * Le mot de passe n'est jamais conservé : `SessionManager` l'échange contre des
 * jetons, qui vont dans le trousseau. Le champ est vidé dès l'envoi.
 */
export default function LoginScreen() {
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
      setError(cause instanceof Error ? cause.message : "Connexion impossible.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.orb}><NexusOrb state={busy ? "executing" : "idle"} size={132} /></View>
      <Text style={styles.eyebrow}>PERSONAL INTELLIGENCE OS</Text>
      <Text style={styles.title}>NEXUS</Text>
      <Text style={styles.subtitle}>Votre console personnelle, sur tous vos appareils.</Text>

      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="Adresse"
        placeholderTextColor={theme.color.textFaint}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        accessibilityLabel="Adresse électronique"
      />

      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="Mot de passe"
        placeholderTextColor={theme.color.textFaint}
        secureTextEntry
        autoComplete="current-password"
        accessibilityLabel="Mot de passe"
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
          <Text style={styles.buttonText}>Établir la connexion</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.color.background,
    padding: theme.space(6),
    justifyContent: "center",
    gap: theme.space(3),
  },
  orb: { alignItems: "center", marginBottom: theme.space(2) },
  eyebrow: { color: theme.color.textFaint, fontSize: 11, letterSpacing: 1.4, fontWeight: "700" },
  title: { color: theme.color.text, fontSize: 42, fontWeight: "700", letterSpacing: -1.5 },
  subtitle: { color: theme.color.textMuted, fontSize: 15, marginBottom: theme.space(4) },
  input: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    color: theme.color.text,
    fontSize: 16,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3.5),
  },
  button: {
    backgroundColor: theme.color.accent,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space(4),
    alignItems: "center",
    marginTop: theme.space(2),
  },
  buttonBusy: { opacity: 0.7 },
  buttonText: { color: theme.color.background, fontSize: 16, fontWeight: "700" },
  error: { color: theme.color.danger, fontSize: 14 },
});
