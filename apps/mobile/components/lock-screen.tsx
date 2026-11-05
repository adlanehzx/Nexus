import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAppLock } from "../lib/app-lock.js";
import { type Theme, useThemedStyles } from "../theme/index.js";
import { NexusOrb } from "./nexus-orb.js";
import { Button } from "./ui.js";

/** Covers everything, including what the app switcher snapshot would show. */
export function LockScreen() {
  const styles = useThemedStyles(makeStyles);
  const lock = useAppLock();

  useEffect(() => {
    void lock.unlock();
    // Prompt once when the lock appears; the button handles later attempts.
  }, []);

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <NexusOrb state="idle" size={110} />
      <Text style={styles.title}>NEXUS is locked</Text>
      <Button
        label="Unlock"
        variant="primary"
        icon="lock-open-outline"
        onPress={() => void lock.unlock()}
      />
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: theme.color.background,
      alignItems: "center",
      justifyContent: "center",
      gap: theme.space(7),
    },
    title: { color: theme.color.text, fontSize: 20, fontWeight: "600" },
  });
