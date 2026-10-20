# 25 — Notifications externes unifiées

Décrit l'architecture du sous-système de notifications externes de NEXUS, couvrant le bureau Linux, le push mobile sans clé et les webhooks vers les messageries.

Paquets : [`@nexus/notifications`](../../packages/notifications), [`services/api`](../../services/api).

---

## 1. Principes d'architecture

Les notifications sont **produites au centre**, jamais de façon décentralisée par chaque client.

```
Événements NEXUS (Fin de tâche, ConfirmationBroker, Alertes)
  │
  ▼
NotificationService (services/api)
  │
  ├── 1. Persistance PostgreSQL (NotificationStore)
  ├── 2. Diffusion WebSocket temps-réel (EventRouter)
  │
  ▼
NotificationDispatcher (@nexus/notifications)
  │
  ├── Évaluation Plages Silencieuses (isQuietHours, bypass si urgent)
  ├── Regroupement & Anti-inondation (NotificationThrottler)
  │
  ├──▶ DesktopChannel (Linux notify-send)
  ├──▶ NtfyChannel (Mobile push via HTTP ntfy.sh)
  └──▶ WebhookChannel (Discord / Telegram / Apprise / Generic)
```

Ce découplage garantit :
1. **Cohérence globale** : Tous les canaux reçoivent la même information avec le même niveau de gravité.
2. **Résilience et non-bloquage** : La panne ou la lenteur d'un service externe (coupure réseau, indisponibilité de serveur ntfy) n'interrompt jamais l'agent ni la tâche en cours.
3. **Zéro secret exposé** : Les jetons d'accès aux webhooks ou aux topics privés sont référencés par `vault://nexus/...` et résolus en mémoire vive sans fuite dans les journaux.

---

## 2. Canaux de diffusion

### 2.1 Bureau Linux (`DesktopChannel`)
- Utilise `/usr/bin/notify-send` en sous-processus.
- Mappe les priorités sur les urgences freedesktop (`low`, `normal`, `critical`).
- Sélectionne les icônes standards du système (`dialog-information`, `dialog-warning`, `dialog-error`).
- Tolérant aux contextes headless : n'émet pas d'exception fatale si aucun serveur d'affichage (Wayland/X11) n'est disponible.

### 2.2 Mobile Push gratuit (`NtfyChannel`)
- Utilise le protocole standard HTTP [ntfy](https://ntfy.sh) en appel `POST`.
- Fonctionne sur le service public gratuit `https://ntfy.sh` comme sur une instance privée auto-hébergée.
- Envoie des en-têtes structurés :
  - `Title` : Titre de l'alerte.
  - `Priority` : Niveau 1 (min) à 5 (urgent).
  - `Tags` : Marqueurs thématiques et visuels.
  - `Click` : URL cliquable redirigeant vers la ressource NEXUS.
  - `Actions` : Bouton d'action direct (`view, Ouvrir, <url>`).
- Supporte l'authentification Bearer optionnelle pour les sujets restreints.

### 2.3 Webhooks externes (`WebhookChannel`)
- Support multi-plateformes avec rendu dédié :
  - **Discord** : Embed structuré avec coloration sémantique par gravité et horodatage.
  - **Telegram** : Message HTML formaté avec balises `<b>`, liens directs et échappement strict des caractères spéciaux.
  - **Apprise** : Payload compatible avec le micro-serveur universel Apprise.
  - **Generic** : Format JSON extensible comprenant toutes les métadonnées de l'événement.

---

## 3. Politiques de diffusion

### 3.1 Plages silencieuses (*Quiet Hours*)
- Plage horaire configurable (ex. `22:00` - `08:00`) avec définition explicite du fuseau horaire (ex. `Europe/Paris`).
- Prise en charge automatique du franchissement de minuit.
- **Règle de contournement** : Les alertes de niveau `urgent` ou `high` (notamment les confirmations requises pour débloquer un agent) franchissent les plages silencieuses lorsque `allowUrgent` est activé, tandis que les notifications informatives ordinaires sont mises en sourdine.

### 3.2 Regroupement et anti-inondation (*Throttling*)
- Un agent générant des alertes répétées peut saturer l'attention de l'utilisateur.
- `NotificationThrottler` applique un fenêtrage glissant (30 secondes par défaut) basé sur une clé `groupKey` (par ex. `task-<taskId>` ou `confirmation-<id>`).
- Seule la première notification est transmise immédiatement ; les suivantes sont agrégées et le décompte des messages supprimés est rapporté lors de l'expiration de la fenêtre.

### 3.3 Liens d'action directs (*Click-Through Links*)
- Toute fin de tâche génère un lien profond vers son onglet :
  `${dashboardBaseUrl}/dashboard?tab=tasks&taskId=<taskId>`
- Toute demande de confirmation humaine génère un lien d'approbation instantanée :
  `${dashboardBaseUrl}/dashboard?tab=confirmations&id=<confirmationId>`

---

## 4. Administration et supervision

Les routes administratives suivantes permettent de piloter le sous-système depuis le dashboard :

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/api/v1/dashboard/notifications/config` | Lecture de la configuration des canaux externes |
| `PUT` | `/api/v1/dashboard/notifications/config` | Enregistrement et mise à jour dynamique des canaux |
| `POST` | `/api/v1/dashboard/notifications/test` | Émission d'un test réel et rapport de livraison |
