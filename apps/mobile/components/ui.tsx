import type { ComponentProps, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { KeyboardAware } from "./keyboard-aware.js";
import type { Failure } from "../lib/errors.js";
import { statusTone, type Tone } from "../lib/format.js";
import type { Resource } from "../lib/use-resource.js";
import { type Theme, useTheme, useThemedStyles } from "../theme/index.js";

/**
 * Screen primitives.
 *
 * Every server-backed screen has the same four states; centralizing them is
 * what makes "administrator only", "offline" and "empty" read the same across
 * the app, and keeps each screen to what is specific about it.
 */

export type IconName = ComponentProps<typeof Ionicons>["name"];

export function toneColor(tone: Tone, theme: Theme): string {
  switch (tone) {
    case "ok":
      return theme.color.success;
    case "live":
      return theme.color.signal;
    case "warn":
      return theme.color.warning;
    case "bad":
      return theme.color.danger;
    case "muted":
      return theme.color.textFaint;
  }
}

export function Card({
  children,
  onPress,
  style,
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  accessibilityLabel?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  if (onPress === undefined) return <View style={[styles.card, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      style={({ pressed }) => [styles.card, style, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

export function Badge({ label, status, tone }: { label?: string; status?: string; tone?: Tone }) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const resolved = tone ?? statusTone(status ?? "");
  const color = toneColor(resolved, theme);
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <View style={[styles.badgeDot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]} numberOfLines={1}>
        {label ?? (status ?? "").replace(/_/g, " ").toLowerCase()}
      </Text>
    </View>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {action}
    </View>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text
        style={[styles.statValue, tone === undefined ? null : { color: toneColor(tone, theme) }]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function StatRow({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.statRow}>{children}</View>;
}

export function ProgressBar({ percent, tone = "live" }: { percent: number; tone?: Tone }) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <View
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: clamped }}
    >
      <View
        style={[styles.fill, { width: `${clamped}%`, backgroundColor: toneColor(tone, theme) }]}
      />
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = "secondary",
  disabled,
  busy,
  icon,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const foreground =
    variant === "primary"
      ? theme.color.textOnAccent
      : variant === "danger"
        ? theme.color.danger
        : theme.color.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled === true || busy === true}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true, busy: busy === true }}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && styles.buttonPrimary,
        variant === "danger" && styles.buttonDanger,
        (disabled === true || busy === true) && styles.buttonDisabled,
        pressed && styles.pressed,
      ]}
    >
      {busy === true ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : icon === undefined ? null : (
        <Ionicons name={icon} size={16} color={foreground} />
      )}
      <Text style={[styles.buttonText, { color: foreground }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ListRow({
  icon,
  title,
  detail,
  trailing,
  onPress,
}: {
  icon?: IconName;
  title: string;
  detail?: string;
  trailing?: ReactNode;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const body = (
    <>
      {icon === undefined ? null : (
        <View style={styles.rowIcon}>
          <Ionicons name={icon} size={18} color={theme.color.accent} />
        </View>
      )}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {detail === undefined ? null : (
          <Text style={styles.rowDetail} numberOfLines={2}>
            {detail}
          </Text>
        )}
      </View>
      {trailing}
      {onPress === undefined ? null : (
        <Ionicons name="chevron-forward" size={16} color={theme.color.textFaint} />
      )}
    </>
  );
  if (onPress === undefined) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

const FAILURE_ICON: Record<Failure["kind"], IconName> = {
  network: "cloud-offline-outline",
  auth: "log-in-outline",
  forbidden: "lock-closed-outline",
  notFound: "search-outline",
  unavailable: "pause-circle-outline",
  server: "alert-circle-outline",
};

export function StateView({
  icon,
  title,
  message,
  action,
}: {
  icon: IconName;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.state} accessibilityLiveRegion="polite">
      <Ionicons name={icon} size={36} color={theme.color.textFaint} />
      <Text style={styles.stateTitle}>{title}</Text>
      {message === undefined ? null : <Text style={styles.stateMessage}>{message}</Text>}
      {action}
    </View>
  );
}

export function FailureView({ failure, onRetry }: { failure: Failure; onRetry?: () => void }) {
  return (
    <StateView
      icon={FAILURE_ICON[failure.kind]}
      title={failure.title}
      message={failure.message}
      {...(failure.retryable && onRetry !== undefined
        ? { action: <Button label="Try again" onPress={onRetry} icon="refresh" /> }
        : {})}
    />
  );
}

/** Data stays on screen after a failed refresh; this says it may be out of date. */
export function StaleNotice({ failure }: { failure: Failure }) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.stale} accessibilityLiveRegion="polite">
      <Ionicons name={FAILURE_ICON[failure.kind]} size={14} color={theme.color.warning} />
      <Text style={styles.staleText} numberOfLines={2}>
        Showing the last known data. {failure.title}.
      </Text>
    </View>
  );
}

/**
 * Scrollable screen bound to a resource: loading, failure, then content.
 *
 * `children` only runs with data, so a screen never has to handle `undefined`.
 */
export function ResourceScreen<T>({
  resource,
  children,
}: {
  resource: Resource<T>;
  children: (data: T) => ReactNode;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);

  if (resource.data === undefined) {
    if (resource.failure !== undefined) {
      return (
        <View style={styles.screen}>
          <FailureView failure={resource.failure} onRetry={() => void resource.reload()} />
        </View>
      );
    }
    return (
      <View style={styles.screen}>
        <View style={styles.state}>
          <ActivityIndicator color={theme.color.accent} accessibilityLabel="Loading" />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAware>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={resource.refreshing}
            onRefresh={() => void resource.reload()}
            tintColor={theme.color.textMuted}
          />
        }
      >
        {resource.failure === undefined ? null : <StaleNotice failure={resource.failure} />}
        {children(resource.data)}
      </ScrollView>
    </KeyboardAware>
  );
}

export function ScreenScroll({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <KeyboardAware>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </KeyboardAware>
  );
}

export function useUiStyles() {
  return useThemedStyles(makeStyles);
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.color.background },
    content: { padding: theme.space(6), gap: theme.space(5), paddingBottom: theme.space(10) },
    card: {
      backgroundColor: theme.color.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.color.border,
      padding: theme.space(6),
      gap: theme.space(3),
    },
    pressed: { opacity: 0.72 },
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.space(2),
      borderWidth: 1,
      borderRadius: theme.radius.pill,
      paddingHorizontal: theme.space(3),
      paddingVertical: 2,
      alignSelf: "flex-start",
      flexShrink: 1,
    },
    badgeDot: { width: 6, height: 6, borderRadius: 3 },
    badgeText: { fontSize: 11, fontWeight: "600" },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: theme.space(3),
    },
    sectionTitle: {
      color: theme.color.textFaint,
      fontSize: 12,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    statRow: { flexDirection: "row", gap: theme.space(4) },
    stat: {
      flex: 1,
      backgroundColor: theme.color.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.color.border,
      paddingVertical: theme.space(5),
      paddingHorizontal: theme.space(4),
      gap: theme.space(1),
    },
    statValue: { color: theme.color.text, fontSize: 20, fontWeight: "700" },
    statLabel: { color: theme.color.textMuted, fontSize: 12 },
    track: {
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.color.surfaceRaised,
      overflow: "hidden",
    },
    fill: { height: 4 },
    button: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.space(3),
      minHeight: 44,
      paddingHorizontal: theme.space(6),
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.color.borderStrong,
      backgroundColor: theme.color.surface,
    },
    buttonPrimary: { backgroundColor: theme.color.accent, borderColor: theme.color.accent },
    buttonDanger: { borderColor: theme.color.danger, backgroundColor: "transparent" },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { fontSize: 14, fontWeight: "600" },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.space(4),
      minHeight: 52,
      paddingVertical: theme.space(3),
    },
    rowIcon: {
      width: 32,
      height: 32,
      borderRadius: theme.radius.md,
      backgroundColor: theme.color.accentMuted,
      alignItems: "center",
      justifyContent: "center",
    },
    rowText: { flex: 1, gap: 2 },
    rowTitle: { color: theme.color.text, fontSize: 15, fontWeight: "500" },
    rowDetail: { color: theme.color.textMuted, fontSize: 12, lineHeight: 17 },
    state: {
      flex: 1,
      minHeight: 280,
      alignItems: "center",
      justifyContent: "center",
      gap: theme.space(4),
      padding: theme.space(8),
    },
    stateTitle: { color: theme.color.text, fontSize: 17, fontWeight: "600", textAlign: "center" },
    stateMessage: {
      color: theme.color.textMuted,
      fontSize: 14,
      lineHeight: 20,
      textAlign: "center",
    },
    stale: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.space(3),
      backgroundColor: theme.color.warningBg,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.space(4),
      paddingVertical: theme.space(3),
    },
    staleText: { flex: 1, color: theme.color.warning, fontSize: 12 },
  });
