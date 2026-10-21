# 11 — Stratégie voix

## 1. Principe : la voix est une couche d'entrée/sortie, pas une variante de l'agent

L'agent ne sait pas s'il parle à quelqu'un qui a tapé ou parlé. Il reçoit du texte, il produit du
texte. La chaîne audio est branchée **avant** et **après** lui, jamais dedans
(→ [ADR-012](../adr/ADR-012-voice-decoupled.md)).

```
Micro → [STT] → texte → Agent (identique au flux texte) → texte → [TTS] → audio
```

Un seul indice traverse la frontière : `Message.inputModality = 'voice' | 'text'`, que le prompt
utilise uniquement pour ajuster le **style** (réponses plus courtes, pas de tableaux markdown,
pas d'URL à lire à voix haute). C'est une consigne de rendu, pas une logique différente.

## 2. Abstractions

```ts
interface STTProvider {
  transcribe(audio: AudioBuffer, opts): Promise<Transcript>; // batch
  stream(opts): STTStream; // → partial / final / vad events
}
interface TTSProvider {
  synthesize(text, opts): Promise<AudioBuffer>;
  stream(textStream, opts): AsyncIterable<AudioChunk>; // phrase par phrase
  listVoices(): Promise<Voice[]>;
}
```

Adaptateurs prévus : cloud (Whisper/Deepgram côté STT, ElevenLabs/OpenAI côté TTS), et **local**
(`whisper.cpp`, Piper) pour un mode confidentialité déployable sur le VPS ou le PC. Le choix est
une configuration, pas une réécriture.

## 3. Deux modes produit

**Mode dictée (v1)** — l'utilisateur appuie, parle, relâche.

- Enregistrement local (`expo-av`), VAD léger pour couper les silences, upload en Opus.
- Transcription affichée et **éditable avant envoi** : corriger un mot mal transcrit est plus
  rapide que refaire la demande, et cela évite qu'un agent agisse sur une transcription fausse.
- Coût faible, latence acceptable, complexité minimale.

**Mode conversation (v2)** — session continue, mains libres.

- Streaming micro → WS (`voice.chunk`, frames binaires Opus 20 ms) → STT en flux.
- Endpointing serveur (silence 700 ms ou fin de phrase détectée) → lancement du run.
- TTS **par phrase** dès que la première phrase est complète : la voix démarre pendant que le
  modèle écrit encore. C'est ce qui fait passer la latence perçue de ~4 s à ~1 s.
- **Barge-in** : si le micro détecte de la parole pendant la lecture, on coupe le TTS, on annule
  le run si l'utilisateur reformule. Sans barge-in, un assistant vocal est insupportable.

## 4. Latence — le budget qui compte

| Étape                                | Cible       | Levier                                        |
| ------------------------------------ | ----------- | --------------------------------------------- |
| Fin de parole → transcription finale | < 400 ms    | STT en flux, endpointing local                |
| Transcription → premier token        | < 800 ms    | contexte préchauffé, modèle rapide en routage |
| Premier token → premier son          | < 500 ms    | TTS phrase par phrase, pas d'attente de fin   |
| **Total perçu**                      | **< 1,5 s** |                                               |

Quand l'agent doit exécuter des outils, la réponse est lente par nature : on comble alors par une
**annonce vocale d'état** (« je regarde tes emails… ») générée localement à partir de
`tool.started`, pas par le LLM.

## 5. Confidentialité

- **Aucun audio n'est conservé**, et ce n'est plus une option mais le défaut — la rétention
  « 7 jours » annoncée ici n'a jamais été implémentée, et l'implémentation a pris l'autre
  direction : il n'existe aucun chemin qui garde un enregistrement. Voir « Rien ne reste »
  ci-dessous.
- Aucun mot-clef d'activation permanent en v1 : le micro ne s'ouvre que sur action explicite.
  Une wake word éventuelle serait **entièrement locale**, sans upload avant déclenchement.
- Les confirmations `CRITICAL` ne sont **jamais** approuvables à la voix : une action irréversible
  exige un geste, pas un mot que le micro pourrait mal comprendre ou capter d'un tiers.
- Les transcriptions passent par la même redaction que le reste avant journalisation.

## 6. Implémentation locale : whisper.cpp et Piper

### Pourquoi local, et pas une API

La dictée porte **tout ce qu'on dit à voix haute chez soi**. Une API de
transcription reçoit l'audio brut d'un micro de salon, et elle le reçoit même
quand la phrase n'était pas pour l'assistant. La synthèse est le même problème
dans l'autre sens : lire à voix haute une réponse, c'est prononcer le contenu
d'un agenda et d'une boîte mail.

`@nexus/voice` fait donc tourner les deux sur la machine : whisper.cpp pour la
dictée, Piper pour la voix. Aucun compte, aucune clé, aucun réseau.

### La chaîne, et où elle peut laisser des traces

```
  dictée   micro (arecord) → WAV temporaire → whisper.cpp → texte
                                   ↑
                        supprimé, suppression VÉRIFIÉE

  voix     texte → piper (stdin) → audio brut → aplay (stdin)
                        aucun fichier, donc rien à supprimer
```

L'asymétrie est dans l'outil : whisper.cpp exige un fichier d'entrée, Piper
accepte un tube. La dictée a donc un fichier à faire disparaître, la synthèse
non.

### Rien ne reste

« Aucun audio conservé » est la promesse la plus facile à faire et la plus
facile à trahir : un `return` anticipé, une exception, un processus tué au
mauvais moment, et un enregistrement de la cuisine reste sur le disque. Elle ne
tient pas par la discipline mais par un module unique, `AudioScratch`, et trois
règles :

1. **un seul dossier**, en 0700, pour savoir où regarder et pouvoir tout purger ;
2. **la suppression est vérifiée** — un `unlink` dont on ignore le résultat est
   une intention, pas une suppression. Si le fichier survit, la dictée s'arrête
   bruyamment plutôt que de continuer à remplir un dossier ;
3. **le nettoyage passe par `finally`** : l'appelant n'a pas le choix, et le
   chemin d'erreur — précisément celui où l'on oublierait — est couvert.

Une rétention `diagnostic` existe pour comprendre un problème de transcription.
Jamais par défaut, et elle signale chaque fichier qu'elle laisse.

**Ce qui n'est pas garanti**, et il faut le savoir : que les octets ne soient
plus récupérables sur le support. Un `unlink` délie un nom, il ne réécrit pas
les secteurs — et sur un SSD, aucune réécriture logicielle ne le garantit. La
promesse est « NEXUS ne conserve aucun fichier audio », pas « l'audio est
effacé de façon médico-légale ». Confondre les deux serait rassurer à tort.

### Ce que « streaming » veut dire ici

Les transcriptions partielles sont réelles : l'enregistrement est découpé en
segments, chacun transcrit dès qu'il est clos. Mais whisper.cpp travaille par
fenêtres, donc **la latence perçue est celle d'un segment, pas celle d'un
mot** — deux secondes par défaut. Le dire importe : promettre un flux continu
ferait attendre autre chose que ce qui arrive.

### L'interruption vocale

Une synthèse qu'on ne peut pas couper est insupportable : on parle par-dessus,
et la machine continue. `stop()` tue **les deux** processus, et c'est le point
qui compte — ne tuer que la synthèse laisserait le lecteur vider son tampon,
donc parler encore une seconde après qu'on lui a dit de se taire. C'est
exactement ce que l'utilisateur ressent comme « ça ne m'écoute pas ».

La détection de parole est déléguée au port `onSpeechDetected` : la façon de
savoir « quelqu'un parle » dépend de la plateforme, et un seuil d'énergie écrit
dans ce paquet serait faux partout. Sans détecteur, l'interruption est
désactivée — mieux vaut pas d'interruption qu'une interruption qui se déclenche
sur le bruit du ventilateur et coupe chaque phrase.

### Conversation mains libres, et comment elle s'arrête

Un tour : écouter, transcrire, répondre, prononcer, réécouter — sans toucher
l'appareil **entre** les tours.

Ce n'est pas une écoute permanente, et les sorties sont ce qui le garantit :

| sortie             | déclencheur                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `silence`          | un tour n'a rien entendu — on s'arrête de parler, et ça s'arrête |
| `plafond-de-tours` | 20 tours par défaut                                              |
| `plafond-de-durée` | 10 minutes par défaut                                            |
| `demandée`         | `stop()`                                                         |

Un `finally` ferme le micro et la parole quoi qu'il arrive, y compris si l'agent
lève une exception — une sortie par erreur ne doit pas laisser un micro ouvert.

### Essayer, et savoir ce qui manque

```sh
nexus voice check                      # ce qui manque, et le geste qui corrige
nexus voice dictate --seconds 5        # une dictée réelle
nexus voice dictate --seconds 5 --speak
```

`check` existe parce que la voix locale a quatre dépendances externes —
binaire whisper, modèle, binaire Piper, voix — et que leur absence se manifeste
autrement : par un micro qui s'ouvre et ne rend rien. La commande nomme la
pièce manquante et le geste.

`dictate` est la seule vérification qui compte vraiment. Les tests éprouvent le
cycle de vie avec des doublures — ce qu'on lance, ce qu'on tue, ce qu'on
supprime — parce qu'aucune suite de tests ne peut brancher un micro. La qualité
de la dictée, elle, ne se vérifie qu'en parlant.

### Ce qui reste à faire

- **Aucune surface graphique ne l'utilise encore.** Le paquet et la CLI
  fonctionnent ; le bouton micro du tableau de bord et de l'application de
  bureau reste à brancher.
- **La détection de parole n'a pas d'implémentation fournie.** Le port existe,
  l'interruption est testée avec un détecteur injecté ; il manque un détecteur
  réel par plateforme.
- **Les confirmations `CRITICAL` ne sont pas approuvables à la voix**, comme
  décidé plus haut — et rien dans ce paquet ne permet de le faire.
