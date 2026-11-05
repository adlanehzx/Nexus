import { Alert, FlatList, RefreshControl, View } from "react-native";
import { router } from "expo-router";
import { failureMessage } from "../lib/errors.js";
import { formatRelative } from "../lib/format.js";
import { useNexus } from "../lib/nexus.js";
import { useResource } from "../lib/use-resource.js";
import {
  Button,
  Card,
  FailureView,
  ListRow,
  StaleNotice,
  StateView,
  useUiStyles,
} from "../components/ui.js";
import { useTheme } from "../theme/index.js";

/** Conversation history, on the server: the same list on every client. */
export default function ConversationsScreen() {
  const theme = useTheme();
  const ui = useUiStyles();
  const nexus = useNexus();
  const resource = useResource("conversations", () => nexus.mobile.listConversations());

  const open = (id: string) => {
    void nexus.openConversation(id);
    router.back();
  };

  const archive = (id: string, title: string) => {
    Alert.alert(`Archive "${title}"?`, "It leaves this list on all your clients.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Archive",
        style: "destructive",
        onPress: () => {
          nexus.mobile
            .archiveConversation(id)
            .then(resource.reload)
            .catch((cause: unknown) => {
              Alert.alert("Could not archive", failureMessage(cause));
            });
        },
      },
    ]);
  };

  if (resource.data === undefined && resource.failure !== undefined) {
    return (
      <View style={ui.screen}>
        <FailureView failure={resource.failure} onRetry={() => void resource.reload()} />
      </View>
    );
  }

  const conversations = (resource.data ?? []).filter((item) => item.status !== "ARCHIVED");

  return (
    <FlatList
      style={ui.screen}
      contentContainerStyle={ui.content}
      data={conversations}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl
          refreshing={resource.refreshing}
          onRefresh={() => void resource.reload()}
          tintColor={theme.color.textMuted}
        />
      }
      ListHeaderComponent={
        <View style={{ gap: theme.space(4) }}>
          {resource.failure === undefined ? null : <StaleNotice failure={resource.failure} />}
          <Button
            label="New conversation"
            variant="primary"
            icon="add"
            onPress={() => {
              nexus.newConversation();
              router.back();
            }}
          />
        </View>
      }
      renderItem={({ item }) => (
        <Card style={{ paddingVertical: theme.space(2) }}>
          <ListRow
            title={item.title}
            detail={formatRelative(item.updatedAt)}
            trailing={
              item.id === nexus.chat.conversationId ? undefined : (
                <Button
                  label="Archive"
                  onPress={() => {
                    archive(item.id, item.title);
                  }}
                />
              )
            }
            onPress={() => {
              open(item.id);
            }}
          />
        </Card>
      )}
      ListEmptyComponent={
        resource.loading ? null : (
          <StateView
            icon="chatbubbles-outline"
            title="No conversations yet"
            message="They appear here once you start talking with NEXUS."
          />
        )
      }
    />
  );
}
