import { useEffect, useRef, useState } from "react";
import { NativeModules, Pressable, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { startAndroidWorker } from "../src/main.js";
import type { NexusNative, NexusProvisioningNative } from "../src/bridge/native-bridge.js";
import type { AndroidWorker } from "../src/worker.js";
import { provisionAndroidWorker } from "../src/provisioning.js";
import { WorkerScreen } from "./WorkerScreen.js";
import settings from "../nexus.config.json";

/**
 * Root of worker application.
 */
export function App() {
  const startup = useRef(false);
  const [worker, setWorker] = useState<AndroidWorker | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configuration, setConfiguration] = useState<Record<string, string> | null | undefined>();
  const [pairingPayload, setPairingPayload] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);

  const native = NativeModules.NexusWorker as (NexusNative & NexusProvisioningNative) | undefined;

  useEffect(() => {
    if (native === undefined) {
      setError(
        "NexusWorker native module not found. The app was not built with NexusWorkerPackage.",
      );
      return;
    }

    void native
      .loadProvisioning()
      .then((persisted) => {
        const bundled = settings as Record<string, string>;
        if (persisted !== null) {
          setConfiguration({
            ...bundled,
            NEXUS_BACKEND_URL: persisted.apiUrl,
            DEVICE_ID: persisted.deviceId,
          });
        } else if (bundled.NEXUS_BACKEND_URL && bundled.DEVICE_ID) {
          setConfiguration({ ...bundled });
        } else {
          setConfiguration(null);
        }
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Unreadable Android configuration."),
      );
  }, [native]);

  useEffect(() => {
    if (native === undefined || configuration === undefined || configuration === null) return;
    if (startup.current) return;
    startup.current = true;

    const env = { ...configuration };

    if (__DEV__) {
      const scriptURL = NativeModules.SourceCode?.scriptURL as string | undefined;
      if (scriptURL) {
        try {
          const hostMatch = scriptURL.match(/:\/\/([^:/]+)/);
          if (hostMatch && hostMatch[1]) {
            const metroHost = hostMatch[1];
            env.NEXUS_BACKEND_URL = env.NEXUS_BACKEND_URL.replace(
              /:\/\/([^:/]+)/,
              `://${metroHost}`,
            );
          }
        } catch (e) {
          console.error("NEXUS_BACKEND_URL: Error resolving dynamic host", e);
        }
      } else {
        console.warn("NEXUS_BACKEND_URL: Unable to find Metro URL (empty scriptURL)");
      }
    }

    void startAndroidWorker({ native, env })
      .then(({ worker: started }) => {
        setWorker(started);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [configuration, native]);

  const pair = (): void => {
    if (native === undefined) return;
    setPairingBusy(true);
    setError(null);
    void provisionAndroidWorker({
      payload: pairingPayload,
      name: "Android Worker",
      keyAlias: "nexus.device.key",
      native,
    })
      .then((persisted) => {
        setConfiguration({
          ...(settings as Record<string, string>),
          NEXUS_BACKEND_URL: persisted.apiUrl,
          DEVICE_ID: persisted.deviceId,
        });
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Pairing failed."),
      )
      .finally(() => setPairingBusy(false));
  };

  if (error !== null) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.title}>NEXUS Worker</Text>
        <Text style={styles.error}>{error}</Text>
        <Text style={styles.muted}>
          Verify the link then generate a new code from NEXUS → Devices if this one has expired.
        </Text>
        {configuration === null ? (
          <Pressable style={styles.button} onPress={() => setError(null)}>
            <Text style={styles.buttonText}>Retry</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    );
  }

  if (configuration === null) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Add this phone</Text>
        <Text style={styles.muted}>
          In the NEXUS dashboard, open Devices, create a code, then paste the Android link here. It
          expires after 5 minutes and contains no password.
        </Text>
        <TextInput
          style={styles.input}
          value={pairingPayload}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          placeholder="nexus://pair?api=…&token=…"
          placeholderTextColor="#64758a"
          onChangeText={setPairingPayload}
        />
        <Pressable
          style={[styles.button, pairingBusy ? styles.buttonDisabled : undefined]}
          disabled={pairingBusy || pairingPayload.trim().length === 0}
          onPress={pair}
        >
          <Text style={styles.buttonText}>{pairingBusy ? "Pairing…" : "Pair"}</Text>
        </Pressable>
        <Text style={styles.muted}>
          The private key is created in Android Keystore and never leaves this phone.
        </Text>
      </ScrollView>
    );
  }

  if (worker === null) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.title}>NEXUS Worker</Text>
        <Text style={styles.muted}>Starting…</Text>
      </ScrollView>
    );
  }

  return <WorkerScreen worker={worker} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101317" },
  content: { padding: 20, gap: 12 },
  title: { color: "#f4f6f8", fontSize: 22, fontWeight: "600" },
  error: { color: "#ff8f8f", fontSize: 15, lineHeight: 22 },
  muted: { color: "#93a1ad", fontSize: 14, lineHeight: 20 },
  input: {
    minHeight: 110,
    padding: 14,
    borderWidth: 1,
    borderColor: "#33445a",
    borderRadius: 10,
    backgroundColor: "#0b111a",
    color: "#edf5ff",
    textAlignVertical: "top",
  },
  button: {
    alignItems: "center",
    padding: 14,
    borderRadius: 10,
    backgroundColor: "#6ea8fe",
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#07111d", fontWeight: "700" },
});
