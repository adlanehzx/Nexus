# ADR-012 — La voix est découplée de l'agent

**Statut** : Proposé · 2026-09-01

## Contexte

Le produit doit accepter la parole et répondre en voix. La tentation est d'utiliser une API
« speech-to-speech » de bout en bout, ou d'introduire un chemin d'exécution spécifique au mode
vocal. Le cahier des charges demande explicitement de « ne pas coupler la logique voice au backend
agent ».

## Décision

STT et TTS sont des couches d'entrée/sortie autour d'un agent qui ne manipule que du texte.
Ports `STTProvider` et `TTSProvider` dans `@nexus/voice`, adaptateurs cloud et locaux
(`whisper.cpp`, Piper). Un seul indice traverse la frontière : `Message.inputModality`, utilisé
uniquement pour ajuster le **style** de la réponse (plus court, pas de markdown, pas d'URL lue).

Deux modes produit : dictée (v1, transcription éditable avant envoi) puis conversation continue
(v2, streaming, endpointing, TTS phrase par phrase, barge-in).

## Alternatives

- **API speech-to-speech de bout en bout.** Latence excellente et prosodie supérieure. Écarté pour
  la v1 : le modèle vocal devient le cerveau, ce qui court-circuite la boucle agentique, les
  permissions, les confirmations et la mémoire — c'est-à-dire tout le produit. Réenvisageable
  plus tard **derrière le même port**, pour les échanges purement conversationnels sans outil.
- **STT/TTS sur l'appareil uniquement.** Confidentialité maximale et zéro coût serveur, mais
  qualité et latence variables selon le téléphone, et impossible de partager la voix entre
  appareils. Conservé comme option de configuration, pas comme défaut.
- **Un pipeline agent distinct pour la voix.** Double la logique métier, donc double les bugs.
  Rejeté par principe.

## Conséquences

**Positives** — un seul chemin d'exécution à tester et à sécuriser ; changer de fournisseur STT ou
TTS est une configuration ; le mode « tout local » reste atteignable pour la confidentialité ;
les confirmations vocales héritent des mêmes règles que le texte.

**Négatives, acceptées** — latence supérieure à un modèle speech-to-speech natif (budget cible
< 1,5 s perçu, atteint par le TTS phrase par phrase) ; la transcription introduit des erreurs que
l'agent traite comme du texte — d'où l'édition avant envoi en mode dictée, et l'interdiction
d'approuver une action `CRITICAL` à la voix.
