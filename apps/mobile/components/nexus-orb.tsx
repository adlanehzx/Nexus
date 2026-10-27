import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { type Theme, useTheme, useThemedStyles } from "../theme/index.js";

export type OrbState = "idle" | "listening" | "executing" | "waiting" | "error" | "offline";

/** Native equivalent of the desktop Core Orb: one inexpensive transform loop. */
export function NexusOrb({ state = "idle", size = 112 }: { state?: OrbState; size?: number }) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const pulse = useRef(new Animated.Value(0)).current;
  const active = state === "listening" || state === "executing";
  useEffect(() => {
    if (state === "offline") {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: active ? 900 : 2800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: active ? 900 : 2800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [active, pulse, state]);
  const palette = useMemo(
    () =>
      state === "error"
        ? theme.color.danger
        : state === "waiting"
          ? theme.color.warning
          : theme.color.accent,
    [state],
  );
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, active ? 1.12 : 1.06] });
  return (
    <View
      style={[styles.frame, { width: size, height: size, opacity: state === "offline" ? 0.38 : 1 }]}
      accessibilityLabel={`NEXUS ${state}`}
    >
      <Animated.View style={[styles.halo, { borderColor: palette, transform: [{ scale }] }]} />
      <Animated.View
        style={[
          styles.field,
          {
            borderColor: palette,
            transform: [
              { rotate: pulse.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] }) },
            ],
          },
        ]}
      />
      <View style={[styles.core, { backgroundColor: palette, shadowColor: palette }]} />
    </View>
  );
}
const makeStyles = (_theme: Theme) =>
  StyleSheet.create({
    frame: { alignItems: "center", justifyContent: "center" },
    halo: {
      position: "absolute",
      width: "100%",
      height: "100%",
      borderRadius: 999,
      borderWidth: 1,
      opacity: 0.35,
    },
    field: {
      position: "absolute",
      width: "72%",
      height: "72%",
      borderRadius: 999,
      borderWidth: 1,
      borderTopColor: "transparent",
      opacity: 0.7,
    },
    core: {
      width: "38%",
      height: "38%",
      borderRadius: 999,
      shadowOpacity: 0.8,
      shadowRadius: 18,
      elevation: 8,
    },
  });
