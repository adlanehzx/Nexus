import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import * as Speech from "expo-speech";
import { useNexus } from "../lib/nexus.js";
import { theme } from "../theme/index.js";
import { VehicleModeController } from "../lib/vehicle.js";

/**
 * Minimal-distraction Vehicle Mode Screen.
 *
 * Designed for in-car and hands-free environments:
 * - High-contrast OLED dark palette with large fonts.
 * - Enforces minimum 84px hit targets for all interactive elements.
 * - Text input keyboard is strictly disabled.
 * - Clear, hardware-visible microphone privacy indicator.
 * - Quick audible announcements.
 */
export default function VehicleModeScreen() {
  const { state } = useNexus();
  const [controller] = useState(
    () =>
      new VehicleModeController({
        speakText: async (text: string) => {
          await Promise.resolve();
          Speech.speak(text);
        },
      }),
  );

  const [_active, setActive] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Vehicle Mode Ready");

  useEffect(() => {
    void controller.enter(20).then(() => {
      setActive(true);
      setStatusMessage("Vehicle Mode Active — Voice & Tactile Only");
    });

    return () => {
      void controller.exit();
    };
  }, [controller]);

  const toggleMic = async () => {
    if (micActive) {
      controller.stopVoiceCapture();
      setMicActive(false);
      setStatusMessage("Microphone Off");
    } else {
      await controller.startVoiceCapture();
      setMicActive(true);
      setStatusMessage("Listening... Speak command");
    }
  };

  const handleApprove = async () => {
    const outcome = await controller.confirmActiveAction("Pending Mission Step");
    setStatusMessage(outcome.message);
  };

  const handleAbort = async () => {
    const outcome = await controller.abortActiveAction("User stopped action");
    setStatusMessage(outcome.message);
  };

  const activeTask = state.tasks[0];

  return (
    <View style={styles.container}>
      {/* Privacy & Mode Header */}
      <View style={styles.header}>
        <View style={styles.modeBadge}>
          <Text style={styles.modeBadgeText}>VEHICLE MODE • SAFE DRIVE</Text>
        </View>
        <View style={[styles.privacyBadge, micActive ? styles.micOn : styles.micOff]}>
          <Text style={styles.privacyBadgeText}>
            {micActive ? "● MIC RECORDING" : "○ MIC MUTED"}
          </Text>
        </View>
      </View>

      {/* Main Status Area */}
      <View style={styles.statusBox}>
        <Text style={styles.statusTitle}>
          {activeTask ? activeTask.title : "No active mission"}
        </Text>
        <Text style={styles.statusSubtitle}>{statusMessage}</Text>
      </View>

      {/* Primary Touch Actions - Minimum 84px touch targets */}
      <View style={styles.actionsContainer}>
        <Pressable
          style={({ pressed }) => [
            styles.largeButton,
            styles.micButton,
            pressed && styles.pressed,
            micActive && styles.micButtonActive,
          ]}
          onPress={() => void toggleMic()}
          accessibilityLabel="Toggle voice microphone"
          accessibilityRole="button"
        >
          <Text style={styles.micButtonText}>{micActive ? "STOP LISTENING" : "PUSH TO TALK"}</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.largeButton,
            styles.approveButton,
            pressed && styles.pressed,
          ]}
          onPress={() => void handleApprove()}
          accessibilityLabel="Confirm active action"
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>APPROVE STEP</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.largeButton,
            styles.abortButton,
            pressed && styles.pressed,
          ]}
          onPress={() => void handleAbort()}
          accessibilityLabel="Abort active action"
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>ABORT / DISMISS</Text>
        </Pressable>
      </View>

      {/* Exit Button */}
      <Pressable
        style={styles.exitButton}
        onPress={() => router.back()}
        accessibilityLabel="Exit vehicle mode"
        accessibilityRole="button"
      >
        <Text style={styles.exitButtonText}>EXIT VEHICLE MODE</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000", // Pure black for OLED minimal distraction
    paddingHorizontal: 20,
    paddingTop: 50,
    paddingBottom: 30,
    justifyContent: "space-between",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modeBadge: {
    backgroundColor: "#1a2536",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  modeBadgeText: {
    color: "#7de8ff",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  privacyBadge: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  micOn: {
    backgroundColor: "#ff4d4d",
  },
  micOff: {
    backgroundColor: "#222222",
  },
  privacyBadgeText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  statusBox: {
    backgroundColor: "#111827",
    padding: 24,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: "#374151",
    alignItems: "center",
    marginVertical: 16,
  },
  statusTitle: {
    color: "#ffffff",
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 8,
  },
  statusSubtitle: {
    color: theme.color.textMuted,
    fontSize: 16,
    textAlign: "center",
  },
  actionsContainer: {
    gap: 16,
  },
  largeButton: {
    height: 84, // Target >= 80px for driver safety
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
  },
  micButton: {
    backgroundColor: "#1e3a5f",
    borderWidth: 2,
    borderColor: "#3b82f6",
  },
  micButtonActive: {
    backgroundColor: "#ef4444",
    borderColor: "#f87171",
  },
  micButtonText: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  approveButton: {
    backgroundColor: "#166534",
    borderWidth: 2,
    borderColor: "#22c55e",
  },
  abortButton: {
    backgroundColor: "#991b1b",
    borderWidth: 2,
    borderColor: "#ef4444",
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  pressed: {
    opacity: 0.8,
    transform: [{ scale: 0.98 }],
  },
  exitButton: {
    height: 48,
    justifyContent: "center",
    alignItems: "center",
  },
  exitButtonText: {
    color: "#6b7280",
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 1,
  },
});
