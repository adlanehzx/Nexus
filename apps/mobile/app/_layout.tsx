import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NexusProvider } from "../lib/nexus.js";
import { theme } from "../theme/index.js";

/**
 * Racine de l'application.
 *
 * Le fournisseur NEXUS enveloppe tout : les écrans ne construisent aucun
 * service, ils consomment un contexte. Une socket ouverte par un écran serait
 * rouverte à chaque navigation.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <NexusProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.color.background },
            headerTintColor: theme.color.text,
            headerTitleStyle: { fontWeight: "600" },
            contentStyle: { backgroundColor: theme.color.background },
          }}
        >
          <Stack.Screen name="index" options={{ title: "NEXUS" }} />
          <Stack.Screen name="tasks" options={{ title: "Tâches" }} />
          <Stack.Screen name="devices" options={{ title: "Appareils" }} />
          <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
          <Stack.Screen name="memory" options={{ title: "Mémoire" }} />
          <Stack.Screen name="settings" options={{ title: "Réglages" }} />
          <Stack.Screen name="login" options={{ title: "Connexion", headerShown: false }} />
        </Stack>
      </NexusProvider>
    </SafeAreaProvider>
  );
}
