/**
 * Les quatre couches que ce paquet **ne possède pas**.
 *
 * L'historique de conversation appartient au magasin de conversations, les
 * appareils au registre, les tâches au magasin de plans. Les recopier ici
 * créerait une seconde vérité, qui divergerait de la première au premier écart —
 * et c'est toujours la copie qu'on finit par afficher.
 *
 * Ce sont donc des **ports en lecture seule**. `@nexus/memory` ne dépend ni de
 * `@nexus/devices` ni de l'API : il déclare ce dont il a besoin, et l'API branche
 * ses magasins dessus. Corollaire pratique : l'assemblage de contexte se teste
 * sans base, sans registre et sans coordinateur.
 *
 * Aucun de ces ports n'a de méthode d'écriture. Ce n'est pas un oubli : la
 * mémoire lit l'état du système, elle ne le modifie pas.
 */

export interface ConversationTurn {
  role: string;
  content: string;
  createdAt: Date;
}

export interface ConversationHistoryPort {
  /**
   * Les derniers tours d'une conversation.
   *
   * `limit` borne la lecture à la source plutôt qu'après coup : une conversation
   * de six mois ne doit pas traverser le processus pour qu'on en garde dix
   * lignes.
   */
  recentTurns(input: {
    userId: string;
    conversationId: string;
    limit: number;
  }): Promise<ConversationTurn[]>;
}

export interface DeviceSummary {
  id: string;
  name: string;
  role: string;
  status: string;
  capabilities: readonly string[];
}

export interface DeviceContextPort {
  /**
   * La flotte de l'utilisateur.
   *
   * Le modèle en a besoin pour répondre « je peux le faire sur le poste fixe »
   * plutôt que de proposer une action qu'aucune machine ne sait exécuter.
   */
  devicesFor(userId: string): Promise<DeviceSummary[]>;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  completedAt: Date | null;
  /** Machine qui l'a exécutée, quand elle est connue. */
  deviceName: string | null;
}

export interface TaskHistoryPort {
  /** Les dernières tâches de l'utilisateur, terminées ou en cours. */
  recentTasks(input: { userId: string; limit: number }): Promise<TaskSummary[]>;
}
