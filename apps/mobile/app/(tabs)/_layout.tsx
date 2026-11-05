import { Redirect, Tabs } from "expo-router";
import { View, type ColorValue } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { pendingConfirmations, unreadNotifications } from "@nexus/client-core";
import { useNexus } from "../../lib/nexus.js";
import { useTheme } from "../../theme/index.js";
import type { IconName } from "../../components/ui.js";

/**
 * The five places a person goes on a phone.
 *
 * Not the dashboard's sidebar: the frequent, thumb-reachable things are tabs,
 * and the rarely-visited administration sits one level down under More. Badges
 * only count what is waiting for the user.
 */
export default function TabsLayout() {
  const theme = useTheme();
  const nexus = useNexus();

  if (!nexus.ready) return <View style={{ flex: 1, backgroundColor: theme.color.background }} />;
  if (!nexus.authenticated) return <Redirect href="/login" />;

  const approvals =
    pendingConfirmations(nexus.state).length + (nexus.chat.pendingConfirmation === null ? 0 : 1);
  const unread = unreadNotifications(nexus.state).length;

  const icon =
    (name: IconName, focused: IconName) =>
    ({
      color,
      size,
      focused: isFocused,
    }: {
      color: ColorValue;
      size: number;
      focused: boolean;
    }) => <Ionicons name={isFocused ? focused : name} size={size} color={color} />;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.color.background },
        headerTintColor: theme.color.text,
        headerTitleStyle: { fontWeight: "600" },
        headerShadowVisible: false,
        tabBarActiveTintColor: theme.color.accent,
        tabBarInactiveTintColor: theme.color.textFaint,
        tabBarStyle: {
          backgroundColor: theme.color.background,
          borderTopColor: theme.color.border,
        },
        tabBarBadgeStyle: {
          backgroundColor: theme.color.accent,
          color: theme.color.textOnAccent,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Chat",
          headerTitle: "NEXUS",
          tabBarIcon: icon("chatbubble-ellipses-outline", "chatbubble-ellipses"),
        }}
      />
      <Tabs.Screen
        name="missions"
        options={{
          title: "Missions",
          tabBarIcon: icon("rocket-outline", "rocket"),
          ...(approvals > 0 ? { tabBarBadge: approvals } : {}),
        }}
      />
      <Tabs.Screen
        name="agents"
        options={{ title: "Agents", tabBarIcon: icon("sparkles-outline", "sparkles") }}
      />
      <Tabs.Screen
        name="devices"
        options={{ title: "Devices", tabBarIcon: icon("hardware-chip-outline", "hardware-chip") }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: "More",
          tabBarIcon: icon("grid-outline", "grid"),
          ...(unread > 0 ? { tabBarBadge: unread } : {}),
        }}
      />
    </Tabs>
  );
}
