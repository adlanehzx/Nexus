import { unreadNotifications } from "@nexus/client-core";
import { router, type Href } from "expo-router";
import { View } from "react-native";
import { useNexus } from "../../lib/nexus.js";
import {
  Badge,
  Card,
  ListRow,
  ScreenScroll,
  SectionHeader,
  type IconName,
} from "../../components/ui.js";

interface Destination {
  icon: IconName;
  title: string;
  detail: string;
  href: Href;
  badge?: number;
}

/** What is visited occasionally, grouped by intent rather than by backend module. */
export default function MoreScreen() {
  const nexus = useNexus();
  const unread = unreadNotifications(nexus.state).length;

  const sections: { title: string; items: Destination[] }[] = [
    {
      title: "Activity",
      items: [
        {
          icon: "notifications-outline",
          title: "Notifications",
          detail: "Finished missions, approvals, errors",
          href: "/notifications",
          badge: unread,
        },
        {
          icon: "pulse-outline",
          title: "Usage & quotas",
          detail: "Consumption, limits, estimated costs",
          href: "/usage",
        },
      ],
    },
    {
      title: "Control",
      items: [
        {
          icon: "game-controller-outline",
          title: "Remote control",
          detail: "Pause NEXUS, instruct devices, send commands",
          href: "/remote",
        },
        {
          icon: "extension-puzzle-outline",
          title: "MCP Hub",
          detail: "Servers, tools and permissions",
          href: "/mcp",
        },
        {
          icon: "git-network-outline",
          title: "Models & providers",
          detail: "Routing, accounts, connections",
          href: "/providers",
        },
      ],
    },
    {
      title: "Personal",
      items: [
        {
          icon: "library-outline",
          title: "Memory",
          detail: "What NEXUS remembers about you",
          href: "/memory",
        },
        {
          icon: "car-outline",
          title: "Vehicle mode",
          detail: "Large controls for the road",
          href: "/vehicle",
        },
        {
          icon: "settings-outline",
          title: "Settings",
          detail: "Account, security, voice, appearance",
          href: "/settings",
        },
      ],
    },
  ];

  return (
    <ScreenScroll>
      {sections.map((section) => (
        <View key={section.title} style={{ gap: 8 }}>
          <SectionHeader title={section.title} />
          <Card>
            {section.items.map((item) => (
              <ListRow
                key={item.title}
                icon={item.icon}
                title={item.title}
                detail={item.detail}
                {...(item.badge === undefined || item.badge === 0
                  ? {}
                  : { trailing: <Badge label={String(item.badge)} tone="live" /> })}
                onPress={() => {
                  router.push(item.href);
                }}
              />
            ))}
          </Card>
        </View>
      ))}
    </ScreenScroll>
  );
}
