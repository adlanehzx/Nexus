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

- L'audio brut est supprimé après 7 jours (transcription conservée) ; option « ne jamais
  conserver l'audio ».
- Aucun mot-clef d'activation permanent en v1 : le micro ne s'ouvre que sur action explicite.
  Une wake word éventuelle serait **entièrement locale**, sans upload avant déclenchement.
- Les confirmations `CRITICAL` ne sont **jamais** approuvables à la voix : une action irréversible
  exige un geste, pas un mot que le micro pourrait mal comprendre ou capter d'un tiers.
- Les transcriptions passent par la même redaction que le reste avant journalisation.
