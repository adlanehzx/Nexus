import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NexusProvider } from "../lib/nexus.js";
import { ThemeProvider, useTheme } from "../theme/index.js";

/**
 * Application root layout.
 *
 * NexusProvider wraps the entire application: screens consume context
 * rather than instantiating services. ThemeProvider sits outside the
 * navigator because the navigator itself is styled from the active theme,
 * and a provider cannot colour its own parent.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <NexusProvider>
          <Navigator />
        </NexusProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Navigator() {
  const theme = useTheme();
  return (
    <>
      {/* The status bar text has to contrast with the app, not with the OS. */}
      <StatusBar style={theme.name === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.color.background },
          headerTintColor: theme.color.text,
          headerTitleStyle: { fontWeight: "600" },
          headerShadowVisible: false,
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
    </>
  );
}
