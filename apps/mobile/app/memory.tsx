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
import { theme } from "../theme/index.js";

/**
 * La mémoire, vue depuis l'iPhone.
 *
 * Un assistant qui retient des choses sans qu'on puisse les voir est une boîte
 * noire ; cet écran est ce qui l'en empêche. Trois principes le gouvernent :
 *
 *  1. **Tout est visible.** Ce que NEXUS retient s'affiche en clair, y compris
 *     ce qu'il a *déduit* — signalé comme tel, parce qu'une inférence n'a pas
 *     l'autorité d'une phrase dictée.
 *  2. **Tout est effaçable.** Un souvenir se supprime d'un geste, et l'écran dit
 *     ce qui a disparu.
 *  3. **Rien de sensible n'entre en silence.** Un contenu personnel déclenche
 *     une question ; un secret est refusé, avec l'explication du cœur.
 *
 * Les préférences sont séparées des souvenirs, parce qu'elles n'ont pas la même
 * fonction : une préférence est une consigne permanente, un souvenir est un
 * fait. Les mélanger ferait perdre les trois lignes qui comptent au milieu de
 * cinquante.
 */

type Onglet = "LONG_TERM" | "PREFERENCE";

export default function MemoryScreen() {
  const nexus = useNexus();

  const [onglet, setOnglet] = useState<Onglet>("LONG_TERM");
  const [souvenirs, setSouvenirs] = useState<ApiMemory[]>([]);
  const [chargement, setChargement] = useState(true);
  const [saisie, setSaisie] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback(async () => {
    setChargement(true);
    try {
      setSouvenirs(await nexus.api.listMemory(onglet));
      setErreur(null);
    } catch (cause) {
      setErreur(cause instanceof Error ? cause.message : "Mémoire illisible.");
    } finally {
      setChargement(false);
    }
  }, [nexus.api, onglet]);

  useEffect(() => {
    void charger();
  }, [charger]);

  /**
   * Enregistre, en posant la question quand il le faut.
   *
   * Le premier appel part **sans** accord. Si le cœur répond
   * `MEMORY_CONSENT_REQUIRED`, on montre son explication et on demande ; ce
   * n'est qu'après un « oui » que le second appel porte `acknowledgedSensitive`.
   * Envoyer l'accord dès le départ viderait la règle de son sens.
   */
  const enregistrer = async (acknowledged = false) => {
    const contenu = saisie.trim();
    if (contenu.length === 0) return;

    setOccupe(true);
    try {
      await nexus.api.storeMemory({
        content: contenu,
        layer: onglet,
        acknowledgedSensitive: acknowledged,
      });
      setSaisie("");
      setErreur(null);
      await charger();
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      const message = cause instanceof Error ? cause.message : "Enregistrement impossible.";

      if (code === "MEMORY_CONSENT_REQUIRED") {
        Alert.alert("Information personnelle", message, [
          { text: "Annuler", style: "cancel" },
          {
            text: "Mémoriser quand même",
            onPress: () => {
              void enregistrer(true);
            },
          },
        ]);
      } else {
        // Un refus de secret n'est pas négociable : on affiche l'explication du
        // cœur, qui dit quoi faire à la place.
        setErreur(message);
      }
    } finally {
      setOccupe(false);
    }
  };

  const oublier = (souvenir: ApiMemory) => {
    Alert.alert("Oublier ce souvenir ?", souvenir.content, [
      { text: "Annuler", style: "cancel" },
      {
        text: "Oublier",
        style: "destructive",
        onPress: () => {
          void nexus.api
            .forgetMemory(souvenir.id)
            .then(charger)
            .catch(() => {
              setErreur("Suppression impossible.");
            });
        },
      },
    ]);
  };

  const toutOublier = () => {
    // Deux fenêtres, délibérément. Un souvenir effacé se redit ; une mémoire
    // entière ne se reconstitue pas, et un seul appui ne doit pas suffire.
    Alert.alert(
      "Tout oublier ?",
      "NEXUS perdra tout ce qu'il sait de vous. Cette action est définitive.",
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Continuer",
          style: "destructive",
          onPress: () => {
            Alert.alert("Confirmer", "Dernière vérification : effacer toute la mémoire ?", [
              { text: "Annuler", style: "cancel" },
              {
                text: "Effacer tout",
                style: "destructive",
                onPress: () => {
                  void nexus.api
                    .forgetAllMemory(true)
                    .then(charger)
                    .catch(() => {
                      setErreur("Effacement impossible.");
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
        <Onglets actif={onglet} onChange={setOnglet} />
      </View>

      {erreur === null ? null : (
        <Pressable
          style={styles.error}
          onPress={() => {
            setErreur(null);
          }}
        >
          <Text style={styles.errorText}>{erreur}</Text>
        </Pressable>
      )}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={saisie}
          placeholder={
            onglet === "PREFERENCE"
              ? "Une consigne permanente…  (ex. réponds toujours en français)"
              : "Quelque chose que NEXUS doit retenir…"
          }
          placeholderTextColor={theme.color.textFaint}
          multiline
          onChangeText={setSaisie}
        />
        <Pressable
          style={[styles.button, (occupe || saisie.trim().length === 0) && styles.buttonDisabled]}
          disabled={occupe || saisie.trim().length === 0}
          onPress={() => {
            void enregistrer();
          }}
          accessibilityRole="button"
          accessibilityLabel="Mémoriser"
        >
          {occupe ? (
            <ActivityIndicator color={theme.color.text} />
          ) : (
            <Text style={styles.buttonText}>Mémoriser</Text>
          )}
        </Pressable>
      </View>

      {chargement ? (
        <ActivityIndicator style={styles.loader} color={theme.color.accent} />
      ) : (
        <FlatList
          data={souvenirs}
          keyExtractor={(souvenir) => souvenir.id}
          contentContainerStyle={styles.list}
          onRefresh={() => {
            void charger();
          }}
          refreshing={false}
          renderItem={({ item }) => <Souvenir souvenir={item} onForget={oublier} />}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {onglet === "PREFERENCE"
                ? "Aucune préférence. Une consigne posée ici vaut pour toutes vos conversations."
                : "NEXUS ne retient rien pour l'instant."}
            </Text>
          }
          ListFooterComponent={
            souvenirs.length === 0 ? null : (
              <Pressable style={styles.dangerButton} onPress={toutOublier}>
                <Text style={styles.dangerText}>Tout oublier</Text>
              </Pressable>
            )
          }
        />
      )}
    </View>
  );
}

function Onglets({ actif, onChange }: { actif: Onglet; onChange: (onglet: Onglet) => void }) {
  return (
    <>
      {(
        [
          ["LONG_TERM", "Souvenirs"],
          ["PREFERENCE", "Préférences"],
        ] as const
      ).map(([valeur, libelle]) => (
        <Pressable
          key={valeur}
          style={[styles.tab, actif === valeur && styles.tabActive]}
          onPress={() => {
            onChange(valeur);
          }}
          accessibilityRole="tab"
          accessibilityState={{ selected: actif === valeur }}
        >
          <Text style={[styles.tabText, actif === valeur && styles.tabTextActive]}>{libelle}</Text>
        </Pressable>
      ))}
    </>
  );
}

function Souvenir({
  souvenir,
  onForget,
}: {
  souvenir: ApiMemory;
  onForget: (souvenir: ApiMemory) => void;
}) {
  const deduit = souvenir.origin === "AGENT";
  const sensible = souvenir.sensitivity === "PERSONAL";

  return (
    <View style={[styles.card, sensible && styles.cardSensitive]}>
      <Text style={styles.content}>{souvenir.content}</Text>

      <View style={styles.meta}>
        {deduit ? (
          // Une inférence n'engage pas l'utilisateur. Le dire lui permet de
          // corriger ce que NEXUS a cru comprendre.
          <Text style={styles.badge}>déduit par NEXUS</Text>
        ) : (
          <Text style={styles.badge}>vous l'avez dit</Text>
        )}

        {sensible ? (
          <Text style={[styles.badge, styles.badgeSensitive]}>
            personnel · {souvenir.sensitiveCategories.join(", ")}
          </Text>
        ) : null}

        {souvenir.supersedesId === null ? null : <Text style={styles.badge}>corrigé</Text>}
      </View>

      <Pressable
        style={styles.forget}
        onPress={() => {
          onForget(souvenir);
        }}
        accessibilityRole="button"
        accessibilityLabel={`Oublier : ${souvenir.content}`}
      >
        <Text style={styles.forgetText}>Oublier</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.background },

  tabs: {
    flexDirection: "row",
    gap: theme.space(2),
    padding: theme.space(4),
    paddingBottom: theme.space(2),
  },
  tab: {
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(4),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  tabActive: { backgroundColor: theme.color.accent, borderColor: theme.color.accent },
  tabText: { color: theme.color.textMuted, fontSize: 14, fontWeight: "600" },
  tabTextActive: { color: theme.color.background },

  error: {
    marginHorizontal: theme.space(4),
    marginBottom: theme.space(2),
    padding: theme.space(3),
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.color.danger,
  },
  errorText: { color: theme.color.danger, fontSize: 13, lineHeight: 18 },

  composer: { paddingHorizontal: theme.space(4), gap: theme.space(2) },
  input: {
    minHeight: 44,
    maxHeight: 120,
    padding: theme.space(3),
    borderRadius: theme.radius.md,
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
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.accent,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: theme.color.background, fontSize: 15, fontWeight: "700" },

  loader: { marginTop: theme.space(10) },
  list: { padding: theme.space(4), gap: theme.space(2), flexGrow: 1 },

  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space(3.5),
    gap: theme.space(2),
  },
  cardSensitive: { borderColor: theme.color.warning },
  content: { color: theme.color.text, fontSize: 15, lineHeight: 21 },

  meta: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(1.5) },
  badge: {
    color: theme.color.textFaint,
    fontSize: 11,
    paddingVertical: 2,
    paddingHorizontal: theme.space(2),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surfaceRaised,
    overflow: "hidden",
  },
  badgeSensitive: { color: theme.color.warning },

  forget: { alignSelf: "flex-start" },
  forgetText: { color: theme.color.danger, fontSize: 13, fontWeight: "600" },

  dangerButton: {
    marginTop: theme.space(6),
    alignItems: "center",
    paddingVertical: theme.space(3),
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.danger,
  },
  dangerText: { color: theme.color.danger, fontSize: 14, fontWeight: "700" },

  empty: {
    color: theme.color.textMuted,
    fontSize: 15,
    lineHeight: 21,
    marginTop: theme.space(8),
    textAlign: "center",
  },
});
