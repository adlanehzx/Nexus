import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NexusProvider } from "../lib/nexus.js";
import { theme } from "../theme/index.js";

/**
 * Application root layout.
 *
 * NexusProvider wraps the entire application: screens consume context
 * rather than instantiating services.
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
          <Stack.Screen name="tasks" options={{ title: "Tasks" }} />
          <Stack.Screen name="devices" options={{ title: "Devices" }} />
          <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
          <Stack.Screen name="memory" options={{ title: "Memory" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
          <Stack.Screen name="login" options={{ title: "Sign In", headerShown: false }} />
        </Stack>
      </NexusProvider>
    </SafeAreaProvider>
  );
}
