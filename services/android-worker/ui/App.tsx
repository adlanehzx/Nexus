import { useEffect, useRef, useState } from "react";
import { NativeModules, ScrollView, StyleSheet, Text } from "react-native";
import { startAndroidWorker } from "../src/main.js";
import type { NexusNative } from "../src/bridge/native-bridge.js";
import type { AndroidWorker } from "../src/worker.js";
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

  useEffect(() => {
    if (demarrage.current) return;
    demarrage.current = true;

    const natif = NativeModules.NexusWorker as NexusNative | undefined;
    if (natif === undefined) {
      setErreur(
        "Le module natif NexusWorker est introuvable. L'application n'a pas été construite avec NexusWorkerPackage.",
      );
      return;
    }

    const env = { ...(reglages as Record<string, string>) };

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
  }, []);

  if (erreur !== null) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.title}>NEXUS Worker</Text>
        <Text style={styles.error}>{erreur}</Text>
        <Text style={styles.muted}>
          Vérifiez `nexus.config.json` puis reconstruisez l&apos;application. Le worker refuse de
          démarrer à moitié configuré : il se ferait choisir par le cœur, puis échouerait tâche
          après tâche.
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
});
