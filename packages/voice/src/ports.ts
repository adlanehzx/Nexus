/**
 * Ports du plan vocal local.
 *
 * Tout ce qui parle au système — micro, moteur de transcription, synthèse,
 * haut-parleur — passe par un port. Ce n'est pas une préférence
 * architecturale : c'est la seule façon d'éprouver la chaîne vocale, parce
 * qu'aucune suite de tests ne peut brancher un micro. Ce qui est testé est
 * donc le **cycle de vie** — ce qu'on lance, avec quels arguments, ce qu'on
 * tue, ce qu'on supprime — et c'est précisément là que vivent les erreurs qui
 * coûtent cher : un enregistrement qui reste sur le disque, un processus de
 * synthèse qu'on n'arrête pas, un micro qui ne se ferme jamais.
 */

export interface SpawnedProcess {
  /** Attend la fin et rend le code de sortie. */
  exit(): Promise<number>;
  /** Sortie standard, accumulée. */
  output(): Promise<string>;
  /** Erreur standard, accumulée — pour diagnostiquer, jamais pour l'utilisateur. */
  stderr(): Promise<string>;
  /** Arrêt immédiat. Doit être idempotent : on l'appelle sans savoir. */
  kill(): void;
  readonly running: boolean;
}

export interface ProcessPort {
  /** Lance une commande. `stdin` est écrit puis fermé, s'il est fourni. */
  spawn(command: string, args: readonly string[], stdin?: string): SpawnedProcess;
  /** Le binaire existe-t-il et est-il exécutable ? */
  which(command: string): Promise<string | undefined>;
}

export interface FilePort {
  /** Crée un dossier, accessible au seul propriétaire. */
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  /** Taille en octets, ou `undefined` si absent. */
  size(path: string): Promise<number | undefined>;
  read(path: string): Promise<string>;
}

export interface ClockPort {
  now(): number;
  sleep(ms: number): Promise<void>;
}
