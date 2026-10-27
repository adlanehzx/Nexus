import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ApiMemory } from "@nexus/client-core";
import { useNexus } from "../lib/nexus.js";
import { type Theme, useTheme, useThemedStyles } from "../theme/index.js";

/**
 * Memory inspection and management.
 *
 * All memories are visible and deletable. Sensitive items require explicit user consent.
 * Preferences are displayed separately from general factual memories.
 */

type MemoryTab = "LONG_TERM" | "PREFERENCE";

export default function MemoryScreen() {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const nexus = useNexus();

  const [tab, setTab] = useState<MemoryTab>("LONG_TERM");
  const [memories, setMemories] = useState<ApiMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMemories(await nexus.api.listMemory(tab));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load memory.");
    } finally {
      setLoading(false);
    }
  }, [nexus.api, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Store a memory, prompting for consent if sensitive data is detected.
   */
  const save = async (acknowledged = false) => {
    const content = input.trim();
    if (content.length === 0) return;

    setBusy(true);
    try {
      await nexus.api.storeMemory({
        content,
        layer: tab,
        acknowledgedSensitive: acknowledged,
      });
      setInput("");
      setError(null);
      await load();
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      const message = cause instanceof Error ? cause.message : "Failed to save memory.";

      if (code === "MEMORY_CONSENT_REQUIRED") {
        Alert.alert("Personal information", message, [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remember anyway",
            onPress: () => {
              void save(true);
            },
          },
        ]);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  const forget = (memory: ApiMemory) => {
    Alert.alert("Forget this memory?", memory.content, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Forget",
        style: "destructive",
        onPress: () => {
          void nexus.api
            .forgetMemory(memory.id)
            .then(load)
            .catch(() => {
              setError("Failed to delete.");
            });
        },
      },
    ]);
  };

  const forgetAll = () => {
    Alert.alert(
      "Forget everything?",
      "NEXUS will clear all stored memories. This action is permanent.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          style: "destructive",
          onPress: () => {
            Alert.alert("Confirm", "Final check: clear all memory?", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Clear all",
                style: "destructive",
                onPress: () => {
                  void nexus.api
                    .forgetAllMemory(true)
                    .then(load)
                    .catch(() => {
                      setError("Failed to clear memory.");
                    });
                },
              },
            ]);
          },
        },
      ],
    );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.tabs}>
        <Tabs active={tab} onChange={setTab} />
      </View>

      {error === null ? null : (
        <Pressable
          style={styles.error}
          onPress={() => {
            setError(null);
          }}
        >
          <Text style={styles.errorText}>{error}</Text>
        </Pressable>
      )}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          placeholder={
            tab === "PREFERENCE"
              ? "A persistent instruction… (e.g. always reply concisely)"
              : "Something NEXUS should remember…"
          }
          placeholderTextColor={theme.color.textFaint}
          multiline
          onChangeText={setInput}
        />
        <Pressable
          style={[styles.button, (busy || input.trim().length === 0) && styles.buttonDisabled]}
          disabled={busy || input.trim().length === 0}
          onPress={() => {
            void save();
          }}
          accessibilityRole="button"
          accessibilityLabel="Remember"
        >
          {busy ? (
            <ActivityIndicator color={theme.color.text} />
          ) : (
            <Text style={styles.buttonText}>Remember</Text>
          )}
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator style={styles.loader} color={theme.color.accent} />
      ) : (
        <FlatList
          data={memories}
          keyExtractor={(memory) => memory.id}
          contentContainerStyle={styles.list}
          onRefresh={() => {
            void load();
          }}
          refreshing={false}
          renderItem={({ item }) => <MemoryCard memory={item} onForget={forget} />}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {tab === "PREFERENCE"
                ? "No preferences. Instructions set here apply across all conversations."
                : "NEXUS has no stored memories yet."}
            </Text>
          }
          ListFooterComponent={
            memories.length === 0 ? null : (
              <Pressable style={styles.dangerButton} onPress={forgetAll}>
                <Text style={styles.dangerText}>Forget everything</Text>
              </Pressable>
            )
          }
        />
      )}
    </View>
  );
}

function Tabs({ active, onChange }: { active: MemoryTab; onChange: (tab: MemoryTab) => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {(
        [
          ["LONG_TERM", "Memories"],
          ["PREFERENCE", "Preferences"],
        ] as const
      ).map(([value, label]) => (
        <Pressable
          key={value}
          style={[styles.tab, active === value && styles.tabActive]}
          onPress={() => {
            onChange(value);
          }}
          accessibilityRole="tab"
          accessibilityState={{ selected: active === value }}
        >
          <Text style={[styles.tabText, active === value && styles.tabTextActive]}>{label}</Text>
        </Pressable>
      ))}
    </>
  );
}

function MemoryCard({
  memory,
  onForget,
}: {
  memory: ApiMemory;
  onForget: (memory: ApiMemory) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const deduced = memory.origin === "AGENT";
  const sensitive = memory.sensitivity === "PERSONAL";

  return (
    <View style={[styles.card, sensitive && styles.cardSensitive]}>
      <Text style={styles.content}>{memory.content}</Text>

      <View style={styles.meta}>
        {deduced ? (
          <Text style={styles.badge}>deduced by NEXUS</Text>
        ) : (
          <Text style={styles.badge}>you stated this</Text>
        )}

        {sensitive ? (
          <Text style={[styles.badge, styles.badgeSensitive]}>
            personal · {memory.sensitiveCategories.join(", ")}
          </Text>
        ) : null}

        {memory.supersedesId === null ? null : <Text style={styles.badge}>corrected</Text>}
      </View>

      <Pressable
        style={styles.forget}
        onPress={() => {
          onForget(memory);
        }}
        accessibilityRole="button"
        accessibilityLabel={`Forget: ${memory.content}`}
      >
        <Text style={styles.forgetText}>Forget</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.color.background },

    tabs: {
      flexDirection: "row",
      gap: theme.space(4),
      padding: theme.space(6),
      paddingBottom: theme.space(4),
    },
    tab: {
      paddingVertical: theme.space(4),
      paddingHorizontal: theme.space(6),
      borderRadius: theme.radius.pill,
      backgroundColor: theme.color.surface,
      borderWidth: 1,
      borderColor: theme.color.border,
    },
    tabActive: { backgroundColor: theme.color.accent, borderColor: theme.color.accent },
    tabText: { color: theme.color.textMuted, fontSize: 14, fontWeight: "600" },
    tabTextActive: { color: theme.color.background },

    error: {
      marginHorizontal: theme.space(6),
      marginBottom: theme.space(4),
      padding: theme.space(5),
      borderRadius: theme.radius.lg,
      backgroundColor: theme.color.surfaceRaised,
      borderWidth: 1,
      borderColor: theme.color.danger,
    },
    errorText: { color: theme.color.danger, fontSize: 13, lineHeight: 18 },

    composer: { paddingHorizontal: theme.space(6), gap: theme.space(4) },
    input: {
      minHeight: 44,
      maxHeight: 120,
      padding: theme.space(5),
      borderRadius: theme.radius.lg,
      backgroundColor: theme.color.surface,
      borderWidth: 1,
      borderColor: theme.color.border,
      color: theme.color.text,
      fontSize: 15,
    },
    button: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      borderRadius: theme.radius.lg,
      backgroundColor: theme.color.accent,
    },
    buttonDisabled: { opacity: 0.4 },
    buttonText: { color: theme.color.background, fontSize: 15, fontWeight: "700" },

    loader: { marginTop: theme.space(10) },
    list: { padding: theme.space(6), gap: theme.space(4), flexGrow: 1 },

    card: {
      backgroundColor: theme.color.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.color.border,
      padding: theme.space(6),
      gap: theme.space(4),
    },
    cardSensitive: { borderColor: theme.color.warning },
    content: { color: theme.color.text, fontSize: 15, lineHeight: 21 },

    meta: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(3) },
    badge: {
      color: theme.color.textFaint,
      fontSize: 11,
      paddingVertical: 2,
      paddingHorizontal: theme.space(4),
      borderRadius: theme.radius.pill,
      backgroundColor: theme.color.surfaceRaised,
      overflow: "hidden",
    },
    badgeSensitive: { color: theme.color.warning },

    forget: { alignSelf: "flex-start" },
    forgetText: { color: theme.color.danger, fontSize: 13, fontWeight: "600" },

    dangerButton: {
      marginTop: theme.space(8),
      alignItems: "center",
      paddingVertical: theme.space(5),
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.color.danger,
    },
    dangerText: { color: theme.color.danger, fontSize: 14, fontWeight: "700" },

    empty: {
      color: theme.color.textMuted,
      fontSize: 15,
      lineHeight: 21,
      marginTop: theme.space(9),
      textAlign: "center",
    },
  });
