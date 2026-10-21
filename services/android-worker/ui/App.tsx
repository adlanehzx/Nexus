import { useEffect, useRef, useState } from "react";
import { NativeModules, Pressable, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { startAndroidWorker } from "../src/main.js";
import type { NexusNative, NexusProvisioningNative } from "../src/bridge/native-bridge.js";
import type { AndroidWorker } from "../src/worker.js";
import { provisionAndroidWorker } from "../src/provisioning.js";
import { WorkerScreen } from "./WorkerScreen.js";
import reglages from "../nexus.config.json";

/**
 * Racine de l'application worker.
 *
 * Elle fait trois choses : lire les réglages, démarrer le worker, afficher son
 * état. Elle n'exécute aucune capacité et ne parle jamais au cœur — c'est
 * `WorkerRuntime` qui le fait, depuis `startAndroidWorker`.
 *
 * **Le démarrage a lieu une seule fois**, gardé par une référence plutôt que par
 * l'état : en mode strict de React, un effet est joué deux fois, et deux workers
 * ouvriraient deux sessions pour le même appareil. Le cœur en fermerait une, et
 * le téléphone passerait son temps à se reconnecter.
 */
export function App() {
  const demarrage = useRef(false);
  const [worker, setWorker] = useState<AndroidWorker | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [configuration, setConfiguration] = useState<Record<string, string> | null | undefined>();
  const [pairingPayload, setPairingPayload] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);

  const natif = NativeModules.NexusWorker as (NexusNative & NexusProvisioningNative) | undefined;

  useEffect(() => {
    if (natif === undefined) {
      setErreur(
        "Le module natif NexusWorker est introuvable. L'application n'a pas été construite avec NexusWorkerPackage.",
      );
      return;
    }

    void natif
      .loadProvisioning()
      .then((persisted) => {
        const bundled = reglages as Record<string, string>;
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
        setErreur(cause instanceof Error ? cause.message : "Configuration Android illisible."),
      );
  }, [natif]);

  useEffect(() => {
    if (natif === undefined || configuration === undefined || configuration === null) return;
    if (demarrage.current) return;
    demarrage.current = true;

    const env = { ...configuration };

    // En développement, on réutilise l'hôte de Metro (10.0.2.2 sur émulateur,
    // localhost sur téléphone via adb reverse). En production, la valeur
    // dans nexus.config.json est conservée telle quelle.
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
          console.error("NEXUS_BACKEND_URL: Erreur lors de la résolution dynamique de l'hôte", e);
        }
      } else {
        console.warn("NEXUS_BACKEND_URL: Impossible de trouver l'URL Metro (scriptURL vide)");
      }
    }

    void startAndroidWorker({ native: natif, env })
      .then(({ worker: demarre }) => {
        setWorker(demarre);
      })
      .catch((cause: unknown) => {
        // Le message d'une `WorkerConfigurationError` énumère les variables
        // fautives. Il ne contient aucune valeur, et donc aucun secret.
        setErreur(cause instanceof Error ? cause.message : String(cause));
      });
  }, [configuration, natif]);

  const pair = (): void => {
    if (natif === undefined) return;
    setPairingBusy(true);
    setErreur(null);
    void provisionAndroidWorker({
      payload: pairingPayload,
      name: "Android Worker",
      keyAlias: "nexus.device.key",
      native: natif,
    })
      .then((persisted) => {
        setConfiguration({
          ...(reglages as Record<string, string>),
          NEXUS_BACKEND_URL: persisted.apiUrl,
          DEVICE_ID: persisted.deviceId,
        });
      })
      .catch((cause: unknown) =>
        setErreur(cause instanceof Error ? cause.message : "Appairage impossible."),
      )
      .finally(() => setPairingBusy(false));
  };

  if (erreur !== null) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.title}>NEXUS Worker</Text>
        <Text style={styles.error}>{erreur}</Text>
        <Text style={styles.muted}>
          Vérifiez le lien puis créez un nouveau code depuis NEXUS → Appareils si celui-ci a expiré.
        </Text>
        {configuration === null ? (
          <Pressable style={styles.button} onPress={() => setErreur(null)}>
            <Text style={styles.buttonText}>Réessayer</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    );
  }

  if (configuration === null) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Ajouter ce téléphone</Text>
        <Text style={styles.muted}>
          Dans le dashboard NEXUS, ouvre Appareils, crée un code puis copie le lien Android ici. Il
          expire après cinq minutes et ne contient aucun mot de passe.
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
          <Text style={styles.buttonText}>{pairingBusy ? "Appairage…" : "Appairer"}</Text>
        </Pressable>
        <Text style={styles.muted}>
          La clé privée est créée dans Android Keystore et ne quitte jamais ce téléphone.
        </Text>
      </ScrollView>
    );
  }

  if (worker === null) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.title}>NEXUS Worker</Text>
        <Text style={styles.muted}>Démarrage…</Text>
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
