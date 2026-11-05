import { useCallback, useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useAppLock, useBiometricSupport } from "../lib/app-lock.js";
import { failureMessage } from "../lib/errors.js";
import { useNexus } from "../lib/nexus.js";
import {
  notificationPermission,
  pushOutcomeLabel,
  registerForPush,
  requestNotificationPermission,
  type PermissionState,
  type PushOutcome,
} from "../lib/notifications.js";
import { useResource } from "../lib/use-resource.js";
import {
  type Theme,
  type ThemePreference,
  useTheme,
  useThemePreference,
  useThemedStyles,
} from "../theme/index.js";

/**
 * Settings and session management.
 *
 * Account, security, notifications, voice, appearance. Providers and connections
 * have their own screen; this one holds what concerns this phone and this person.
 */
export default function SettingsScreen() {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const nexus = useNexus();
  const lock = useAppLock();
  const biometrics = useBiometricSupport();
  const [speakReplies, setSpeakReplies] = useState(nexus.voice.speakRepliesEnabled);
  const [permission, setPermission] = useState<PermissionState>("undetermined");
  const [push, setPush] = useState<PushOutcome>();
  const account = useResource("me", () => nexus.mobile.me());

  const deviceId = nexus.session.deviceId;
  const syncPush = useCallback(async () => {
    const current = await notificationPermission();
    setPermission(current);
    if (current === "granted" && deviceId !== null) {
      setPush(await registerForPush(nexus.mobile, deviceId));
    }
  }, [deviceId, nexus.mobile]);

  useFocusEffect(
    useCallback(() => {
      void syncPush();
    }, [syncPush]),
  );

  const enableNotifications = async () => {
    if (permission === "denied") {
      await Linking.openSettings();
      return;
    }
    setPermission(await requestNotificationPermission());
    await syncPush();
  };

  const confirmSignOut = () => {
    Alert.alert("Sign out?", "Your session tokens will be removed from this device.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          void nexus.signOut().then(() => {
            router.replace("/login");
          });
        },
      },
    ]);
  };

  const confirmSignOutEverywhere = () => {
    Alert.alert(
      "Sign out everywhere?",
      "Every session on every device ends, including this one. Each will have to sign in again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out everywhere",
          style: "destructive",
          onPress: () => {
            nexus.mobile
              .logoutEverywhere()
              .then(() => nexus.signOut())
              .then(() => {
                router.replace("/login");
              })
              .catch((cause: unknown) => {
                Alert.alert("Sessions not closed", failureMessage(cause));
              });
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.screen}>
      <Section title="Account">
        <Text style={styles.value}>
          {account.data === undefined
            ? account.failure === undefined
              ? "Loading…"
              : account.failure.title
            : `${account.data.displayName} · ${account.data.email}`}
        </Text>
        <Text style={styles.hint}>{nexus.serverUrl}</Text>
      </Section>

      <Section title="Security">
        <Row
          label="Lock the app"
          hint={
            biometrics?.available === false
              ? biometrics.needsEnrollment
                ? "Set up Face ID, fingerprint or a passcode on this phone first."
                : "This phone has no screen lock."
              : "Ask for Face ID, fingerprint or passcode to open NEXUS."
          }
        >
          <Switch
            value={lock.lockEnabled}
            disabled={biometrics?.available !== true}
            onValueChange={(value) => void lock.setLockEnabled(value)}
            accessibilityLabel="Lock the app"
          />
        </Row>
        <Row
          label="Confirm remote control"
          hint="Authenticate before acting on another device or changing the fleet."
        >
          <Switch
            value={lock.confirmRemote}
            disabled={biometrics?.available !== true}
            onValueChange={(value) => void lock.setConfirmRemote(value)}
            accessibilityLabel="Confirm remote control"
          />
        </Row>
      </Section>

      <Section title="Notifications">
        <Row
          label="System notifications"
          hint={
            permission === "unavailable"
              ? "Not supported by this build."
              : permission === "denied"
                ? "Turned off in system settings."
                : permission === "granted"
                  ? push === undefined
                    ? "On."
                    : pushOutcomeLabel(push)
                  : "Be told when a mission finishes, needs approval, or fails."
          }
        >
          {permission !== "granted" && permission !== "unavailable" ? (
            <Pressable
              style={styles.inlineButton}
              onPress={() => void enableNotifications()}
              accessibilityRole="button"
              accessibilityLabel={
                permission === "denied" ? "Open system settings" : "Turn on notifications"
              }
            >
              <Text style={styles.inlineButtonText}>
                {permission === "denied" ? "Settings" : "Turn on"}
              </Text>
            </Pressable>
          ) : (
            <View />
          )}
        </Row>
      </Section>

      <Section title="Appearance">
        <Row
          label="Theme"
          hint="Following the system is the default: the phone already knows whether it is night."
        >
          <ThemeChoice />
        </Row>
      </Section>

      <Section title="Voice">
        <Row
          label="Read responses aloud"
          hint="Disabled by default: reading answers aloud in public places is usually undesirable."
        >
          <Switch
            value={speakReplies}
            onValueChange={(value) => {
              setSpeakReplies(value);
              nexus.setSpeakReplies(value);
            }}
            accessibilityLabel="Read responses aloud"
          />
        </Row>
      </Section>

      <Section title="This device">
        <Text style={styles.value}>{nexus.session.deviceId ?? "not registered with NEXUS"}</Text>
        <Text style={styles.hint}>
          Session tokens are stored in the system keychain, encrypted by the OS and excluded from
          device backups.
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
      <Pressable
        style={styles.signOut}
        onPress={confirmSignOutEverywhere}
        accessibilityRole="button"
      >
        <Text style={styles.signOutText}>Sign out everywhere</Text>
      </Pressable>
    </ScrollView>
  );
}

/** Light / system / dark, the same three positions as the other NEXUS clients. */
function ThemeChoice() {
  const styles = useThemedStyles(makeStyles);
  const { preference, setPreference } = useThemePreference();
  const options: { id: ThemePreference; label: string }[] = [
    { id: "light", label: "Light" },
    { id: "system", label: "Auto" },
    { id: "dark", label: "Dark" },
  ];

  return (
    <View style={styles.segmented}>
      {options.map((option) => {
        const selected = preference === option.id;
        return (
          <Pressable
            key={option.id}
            style={[styles.segment, selected && styles.segmentSelected]}
            onPress={() => {
              setPreference(option.id);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`${option.label} theme`}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
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
  const styles = useThemedStyles(makeStyles);
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

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    scroll: { flex: 1, backgroundColor: theme.color.background },
    screen: { padding: theme.space(6), gap: theme.space(8), paddingBottom: theme.space(10) },
    inlineButton: {
      minHeight: 36,
      justifyContent: "center",
      paddingHorizontal: theme.space(5),
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.color.accent,
    },
    inlineButtonText: { color: theme.color.accent, fontSize: 13, fontWeight: "600" },
    section: { gap: theme.space(4) },
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
      gap: theme.space(6),
    },
    rowText: { flex: 1, gap: theme.space(2) },
    label: { color: theme.color.text, fontSize: 15 },
    value: { color: theme.color.text, fontSize: 14, fontVariant: ["tabular-nums"] },
    hint: { color: theme.color.textMuted, fontSize: 12, lineHeight: 17 },
    signOut: {
      borderWidth: 1,
      borderColor: theme.color.danger,
      borderRadius: theme.radius.lg,
      paddingVertical: theme.space(6),
      alignItems: "center",
    },
    signOutText: { color: theme.color.danger, fontSize: 15, fontWeight: "600" },
    segmented: {
      flexDirection: "row",
      padding: 2,
      borderWidth: 1,
      borderColor: theme.color.border,
      borderRadius: theme.radius.pill,
      backgroundColor: theme.color.backgroundSunken,
    },
    segment: {
      paddingHorizontal: theme.space(5),
      paddingVertical: theme.space(3),
      borderRadius: theme.radius.pill,
    },
    segmentSelected: { backgroundColor: theme.color.accentMuted },
    segmentText: { color: theme.color.textMuted, fontSize: 13, fontWeight: "600" },
    segmentTextSelected: { color: theme.color.accent },
  });
