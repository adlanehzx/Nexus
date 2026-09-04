/**
 * Ports vers le système Android.
 *
 * Tout ce que ce worker peut faire au téléphone passe par ces quatre interfaces,
 * implémentées côté Kotlin. Deux bénéfices, et le second est le plus important :
 *
 *  1. la logique — validation, politiques, délais, annulation, rédaction — se
 *    teste intégralement sans émulateur ;
 *  2. **la surface d'attaque est énumérable.** Ce fichier est la liste complète
 *    de ce que NEXUS peut demander à cet appareil. Il n'y a pas d'échappatoire :
 *    pas de `runCommand`, pas d'`Intent` arbitraire, pas d'exécution de code.
 *
 * Android n'autorise pas le contrôle à distance arbitraire, et ce worker ne
 * cherche pas à contourner ce principe. Chaque port correspond à une API
 * publique du système, utilisée avec une permission que l'utilisateur a accordée
 * explicitement.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Applications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Application installée, telle que le worker a le droit de la voir.
 *
 * Volontairement pauvre. Depuis Android 11, la **visibilité des paquets** est
 * filtrée : une application ne voit que ce qu'elle déclare dans `<queries>`, à
 * moins de détenir `QUERY_ALL_PACKAGES` — une permission que Google restreint et
 * dont ce worker n'a pas besoin. On déclare donc une requête sur les activités
 * lançables, ce qui donne exactement les applications ouvrables et rien d'autre.
 *
 * Ni version, ni date d'installation, ni permissions, ni signature : rien de
 * tout cela n'aide à ouvrir une application, et l'inventaire logiciel d'un
 * téléphone en dit long sur son propriétaire.
 */
export interface AndroidApp {
  packageName: string;
  label: string;
  /** Vrai si le système fournit une activité de lancement pour ce paquet. */
  launchable: boolean;
}

export interface AndroidAppController {
  /** Applications lançables visibles par le worker. */
  listApps(): Promise<AndroidApp[]>;
  /**
   * Demande l'ouverture d'une application.
   *
   * « Demande » et non « ouvre » : depuis Android 10, une application en
   * arrière-plan ne peut pas toujours démarrer une activité. Le résultat dit ce
   * que le système a répondu, pas ce que l'utilisateur a vu.
   */
  openApp(packageName: string): Promise<{ launched: boolean; reason?: string }>;
  /** Le paquet est-il installé et visible ? */
  isInstalled(packageName: string): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interface graphique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Désignation d'un élément d'interface.
 *
 * L'ordre de préférence est délibéré : un identifiant de vue est stable entre
 * deux versions d'une application, un texte l'est moins, des coordonnées ne le
 * sont pas du tout. Cliquer à l'aveugle en (540, 1200) revient à espérer que
 * rien n'a bougé — et à toucher ce qui s'y trouve, quel qu'il soit.
 */
export type UiSelector =
  | { kind: "viewId"; value: string }
  | { kind: "text"; value: string }
  | { kind: "contentDescription"; value: string }
  | { kind: "coordinates"; x: number; y: number };

export interface UiNode {
  viewId: string | null;
  text: string | null;
  contentDescription: string | null;
  className: string | null;
  clickable: boolean;
  editable: boolean;
  scrollable: boolean;
  bounds: { left: number; top: number; right: number; bottom: number };
}

export type ScrollDirection = "up" | "down" | "left" | "right";

/**
 * Automatisation d'interface.
 *
 * Repose entièrement sur un **service d'accessibilité**, qui est le seul
 * mécanisme légitime d'Android pour agir sur l'interface d'une autre
 * application. Ce service ne peut être activé que par l'utilisateur, dans les
 * réglages du système : aucune API ne permet de l'activer par programme, et ce
 * worker ne cherche pas à contourner cette règle.
 */
export interface AndroidUiController {
  /** Le service d'accessibilité est-il activé par l'utilisateur, ici et maintenant ? */
  isAccessibilityEnabled(): Promise<boolean>;
  /**
   * Résout un sélecteur en nœud d'interface.
   *
   * `undefined` si rien ne correspond — cas parfaitement ordinaire quand l'écran
   * a changé entre la décision et l'action.
   */
  findNode(selector: UiSelector): Promise<UiNode | undefined>;
  click(selector: UiSelector, signal: AbortSignal): Promise<{ clicked: boolean }>;
  /**
   * Saisit du texte dans un champ.
   *
   * Le texte n'est **jamais** journalisé, ni renvoyé, ni placé dans un
   * événement : cette méthode est le chemin normal d'un mot de passe.
   */
  inputText(
    selector: UiSelector,
    text: string,
    signal: AbortSignal,
  ): Promise<{ entered: boolean; characters: number }>;
  scroll(
    direction: ScrollDirection,
    amount: number,
    signal: AbortSignal,
  ): Promise<{ scrolled: boolean }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture d'écran
// ─────────────────────────────────────────────────────────────────────────────

export interface Screenshot {
  /** Image encodée en base64. Jamais écrite sur disque, jamais journalisée. */
  base64: string;
  format: "png" | "jpeg";
  width: number;
  height: number;
  bytes: number;
}

/**
 * Capture d'écran.
 *
 * Le mécanisme retenu est `AccessibilityService.takeScreenshot()` (Android 11+),
 * **le moins privilégié des deux disponibles** :
 *
 *  - il ne demande aucune permission supplémentaire au-delà du service
 *    d'accessibilité déjà activé par l'utilisateur ;
 *  - il capture **une image, sur demande** — l'API ne permet structurellement
 *    pas d'enregistrement continu ;
 *  - il n'exige ni service de premier plan permanent, ni `MediaProjection`.
 *
 * `MediaProjection` a été écarté délibérément : il ouvre un flux vidéo continu,
 * ce dont ce worker n'a pas besoin, et son jeton reste valide bien après la
 * capture. Voir le README pour le raisonnement complet.
 */
export interface AndroidScreenshotProvider {
  isAvailable(): Promise<boolean>;
  /**
   * Capture l'écran une fois.
   *
   * `maxDimension` borne le plus grand côté : une capture pleine résolution d'un
   * écran de téléphone pèse plusieurs mégaoctets, traverse le réseau, et finit
   * dans une fenêtre de contexte.
   */
  capture(maxDimension: number, signal: AbortSignal): Promise<Screenshot>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Émission de notifications — **et uniquement l'émission**.
 *
 * Lire les notifications d'un téléphone est une capacité entièrement différente :
 * elle exige `BIND_NOTIFICATION_LISTENER_SERVICE`, donne accès au contenu de tous
 * les messages reçus, et n'est pas nécessaire ici. Elle n'est pas implémentée, et
 * un test vérifie qu'aucun `NotificationListenerService` n'est déclaré au
 * manifeste.
 */
export interface AndroidNotificationController {
  /** Depuis Android 13, `POST_NOTIFICATIONS` est une permission d'exécution. */
  canPostNotifications(): Promise<boolean>;
  notify(input: {
    title: string;
    body: string;
    channelId: string;
  }): Promise<{ posted: boolean; notificationId: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// État de l'appareil
// ─────────────────────────────────────────────────────────────────────────────

export interface AndroidBatteryState {
  /** Niveau de 0 à 100. */
  percent: number;
  charging: boolean;
  /** Le système est en mode économie d'énergie. */
  powerSaveMode: boolean;
}

export interface AndroidDeviceInspector {
  batteryState(): Promise<AndroidBatteryState>;
  /** Niveau d'API du système. Certaines capacités en dépendent. */
  sdkVersion(): Promise<number>;
}

/** L'ensemble des ports, tel que l'assemblage les reçoit. */
export interface AndroidPlatform {
  apps: AndroidAppController;
  ui: AndroidUiController;
  screenshots: AndroidScreenshotProvider;
  notifications: AndroidNotificationController;
  device: AndroidDeviceInspector;
}
