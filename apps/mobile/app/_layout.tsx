import { useEffect } from "react";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LockScreen } from "../components/lock-screen.js";
import { ServerSetup } from "../components/server-setup.js";
import { AppLockProvider, useAppLock } from "../lib/app-lock.js";
import { NexusProvider } from "../lib/nexus.js";
import { onNotificationTapped } from "../lib/notifications.js";
import { ServerProvider, useServer } from "../lib/server.js";
import { ThemeProvider, useTheme } from "../theme/index.js";

/**
 * Application root layout.
 *
 * NexusProvider wraps the entire application: screens consume context
 * rather than instantiating services. It is keyed by the server address, so
 * pointing the app at another core rebuilds every service rather than leaving a
 * socket attached to the previous one. ThemeProvider sits outside the navigator
 * because the navigator itself is styled from the active theme, and a provider
 * cannot colour its own parent.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ServerProvider>
          <AppLockProvider>
            <Root />
          </AppLockProvider>
        </ServerProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  const theme = useTheme();
  const server = useServer();
  const lock = useAppLock();

  useEffect(
    () =>
      onNotificationTapped((route) => {
        router.navigate(route);
      }),
    [],
  );

  // Nothing about the account renders until the lock has decided.
  if (!server.ready || !lock.ready) return null;

  return (
    <>
      {/* The status bar text has to contrast with the app, not with the OS. */}
      <StatusBar style={theme.name === "dark" ? "light" : "dark"} />
      {server.url === null ? (
        <ServerSetup />
      ) : (
        <NexusProvider key={server.url} serverUrl={server.url}>
          <Navigator />
        </NexusProvider>
      )}
      {lock.locked && <LockScreen />}
    </>
  );
}

function Navigator() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.color.background },
        headerTintColor: theme.color.text,
        headerTitleStyle: { fontWeight: "600" },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: "minimal",
        contentStyle: { backgroundColor: theme.color.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false, title: "NEXUS" }} />
      <Stack.Screen name="login" options={{ title: "Sign In", headerShown: false }} />
      <Stack.Screen
        name="conversations"
        options={{ title: "Conversations", presentation: "modal" }}
      />
      <Stack.Screen name="mission/[id]" options={{ title: "Mission" }} />
      <Stack.Screen name="run/[id]" options={{ title: "Agent run" }} />
      <Stack.Screen name="device/[id]" options={{ title: "Device" }} />
      <Stack.Screen name="tasks" options={{ title: "Tasks" }} />
      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      <Stack.Screen name="usage" options={{ title: "Usage & quotas" }} />
      <Stack.Screen name="mcp" options={{ title: "MCP Hub" }} />
      <Stack.Screen name="remote" options={{ title: "Remote control" }} />
      <Stack.Screen name="providers" options={{ title: "Models & providers" }} />
      <Stack.Screen name="memory" options={{ title: "Memory" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="vehicle" options={{ title: "Vehicle mode" }} />
    </Stack>
  );
}
