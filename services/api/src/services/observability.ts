import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redact, truncate } from "@nexus/shared";

/**
 * Ce que le tableau de bord a le droit de voir.
 *
 * Deux magasins bornés — les journaux applicatifs et les événements de sécurité
 * — et les **projections** qui décident ce qui sort du système.
 *
 * La projection est le cœur de ce fichier, et sa raison d'être tient en une
 * ligne : **le raisonnement du modèle ne sort jamais.** Un run d'agent contient
 * son transcript complet, blocs de raisonnement du fournisseur compris
 * (`LlmMessage.providerBlocks`). Ces blocs existent pour être rejoués au tour
 * suivant, pas pour être lus — ni par le cœur agent, ni par une interface, ni
 * par la personne qui supervise.
 *
 * La garantie est obtenue **par construction, pas par filtrage** : la projection
 * ne lit que `AgentRunRecord`, jamais `AgentState.messages`. On ne peut pas
 * oublier de masquer un champ auquel on n'accède pas.
 *
 * Ce qui sort, et rien d'autre : statut, action, outil, progression, résultat,
 * erreur, métriques.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Journaux applicatifs
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  at: string;
  level: LogLevel;
  message: string;
  /** Identifiant de corrélation, quand la ligne vient d'une requête. */
  correlationId: string | null;
  /** Champs structurés retenus. Rédigés, et bornés. */
  context: Record<string, unknown>;
}

/**
 * Niveaux pino.
 *
 * Deux formes coexistent, et il faut les accepter toutes les deux : pino ecrit
 * un **entier** par defaut, mais ce depot configure `formatters.level` pour
 * ecrire un **libelle**. Ne reconnaitre que la premiere ferait tomber toutes les
 * lignes reelles en `info`, silencieusement — et un tableau de bord ou tout est
 * `info` ne sert a rien.
 */
const PINO_LEVELS: Record<number, LogLevel> = {
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const LEVEL_LABELS = new Set<string>(["debug", "info", "warn", "error", "fatal"]);

function toLevel(value: unknown): LogLevel {
  if (typeof value === "number") return PINO_LEVELS[value] ?? "info";
  if (typeof value === "string" && LEVEL_LABELS.has(value)) return value as LogLevel;
  return "info";
}

/** Meme histoire pour l'horodatage : entier epoch par defaut, ISO ici. */
function toIso(value: unknown): string {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Anneau borné des dernières lignes de journal.
 *
 * **Bornée**, parce qu'un tampon de journaux qui grandit sans limite finit par
 * faire tomber le processus qu'il servait à diagnostiquer.
 *
 * Implémente l'interface d'une destination pino (`write(ligne)`), ce qui permet
 * de la brancher en parallèle de la sortie standard sans intercaler de couche.
 * Les tests l'alimentent avec les mêmes lignes NDJSON que pino produit — c'est
 * le vrai format qui est éprouvé, pas une imitation.
 */
export class LogBuffer {
  readonly #entries: LogEntry[] = [];
  readonly #max: number;
  readonly #filePath: string | undefined;

  constructor(options: { max?: number; filePath?: string } = {}) {
    this.#max = options.max ?? 500;
    this.#filePath = options.filePath;
    this.#entries.push(...readJsonLines<LogEntry>(options.filePath, this.#max));
  }

  /** Destination pino. Une ligne NDJSON par appel. */
  write(line: string): void {
    const entry = parseLogLine(line);
    if (entry !== undefined) this.push(entry);
  }

  push(entry: LogEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > this.#max) this.#entries.splice(0, this.#entries.length - this.#max);
    persistJsonLines(this.#filePath, this.#entries);
  }

  /** Les plus récentes d'abord. */
  list(filter: { level?: LogLevel; limit?: number; search?: string } = {}): LogEntry[] {
    const minimum = filter.level === undefined ? 0 : SEVERITY[filter.level];
    const needle = filter.search?.toLowerCase();

    const matching = this.#entries.filter((entry) => {
      if (SEVERITY[entry.level] < minimum) return false;
      if (needle === undefined) return true;
      return entry.message.toLowerCase().includes(needle);
    });

    return matching.slice(-(filter.limit ?? 100)).reverse();
  }

  get size(): number {
    return this.#entries.length;
  }
}

const SEVERITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

/**
 * Décode une ligne pino.
 *
 * Rend `undefined` sur ce qui n'est pas du JSON : une destination de journal ne
 * doit jamais lever. Elle serait appelée depuis le gestionnaire d'erreur, et
 * une exception y transformerait un incident en panne.
 */
export function parseLogLine(line: string): LogEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object") return undefined;

  const {
    level,
    time,
    msg,
    correlationId,
    pid: _pid,
    hostname: _hostname,
    ...rest
  } = parsed as Record<string, unknown>;

  return {
    at: toIso(time),
    level: toLevel(level),
    message: typeof msg === "string" ? msg : "",
    correlationId: typeof correlationId === "string" ? correlationId : null,
    // Rédaction **à l'entrée** du tampon. Une ligne peut transporter un jeton au
    // milieu d'un champ innocemment nommé, et le tableau de bord l'afficherait
    // tel quel.
    context: redact(rest) as Record<string, unknown>,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Événements de sécurité
// ─────────────────────────────────────────────────────────────────────────────

export type SecurityEventKind =
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "device.registered"
  /** Ticket d'appairage émis. Jamais le code, ni son empreinte. */
  | "device.pairing_ticket_issued"
  /** Appareil créé par un scan de QR, et donc par une présence physique. */
  | "device.paired"
  | "device.trusted"
  | "device.revoked"
  | "device.auth_failed"
  /** Pause globale actionnée. Le motif accompagne la ligne. */
  | "system.paused"
  | "system.resumed"
  | "permission.denied"
  | "confirmation.requested"
  | "confirmation.answered"
  | "memory.refused"
  | "memory.consent_required";

export interface SecurityEvent {
  at: string;
  kind: SecurityEventKind;
  /** `null` quand l'événement précède l'identification — un échec de connexion. */
  userId: string | null;
  /** Résumé affichable. Ne contient jamais de secret ni de contenu. */
  summary: string;
  context: Record<string, unknown>;
}

/**
 * Journal des événements de sécurité.
 *
 * Distinct des journaux applicatifs, et pas par commodité : ce sont des
 * **événements de domaine**, typés, qu'on veut pouvoir compter et filtrer. Les
 * retrouver en fouillant du texte serait fragile, et une ligne de journal
 * reformulée casserait la supervision sans que rien n'échoue.
 *
 * Ce qui n'y entre jamais : un mot de passe, un jeton, un contenu de souvenir.
 * `record` rédige ce qu'on lui donne, mais la vraie règle est en amont — les
 * appelants passent des identifiants et des catégories, pas des valeurs.
 */
export class SecurityLog {
  readonly #events: SecurityEvent[] = [];
  readonly #max: number;
  readonly #now: () => Date;
  readonly #filePath: string | undefined;

  constructor(options: { max?: number; now?: () => Date; filePath?: string } = {}) {
    this.#max = options.max ?? 500;
    this.#now = options.now ?? (() => new Date());
    this.#filePath = options.filePath;
    this.#events.push(...readJsonLines<SecurityEvent>(options.filePath, this.#max));
  }

  record(input: {
    kind: SecurityEventKind;
    userId?: string | null;
    summary: string;
    context?: Record<string, unknown>;
  }): SecurityEvent {
    const event: SecurityEvent = {
      at: this.#now().toISOString(),
      kind: input.kind,
      userId: input.userId ?? null,
      summary: truncate(input.summary, 200),
      context: redact(input.context ?? {}) as Record<string, unknown>,
    };

    this.#events.push(event);
    if (this.#events.length > this.#max) this.#events.splice(0, this.#events.length - this.#max);
    persistJsonLines(this.#filePath, this.#events);

    return event;
  }

  /** Les plus récents d'abord. */
  list(filter: { kind?: SecurityEventKind; limit?: number } = {}): SecurityEvent[] {
    const matching =
      filter.kind === undefined
        ? this.#events
        : this.#events.filter((event) => event.kind === filter.kind);

    return matching.slice(-(filter.limit ?? 100)).reverse();
  }

  /** Compte par type, sur toute la fenêtre retenue. */
  countByKind(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of this.#events) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    return counts;
  }

  get size(): number {
    return this.#events.length;
  }
}

function readJsonLines<T>(filePath: string | undefined, maximum: number): T[] {
  if (filePath === undefined) return [];
  try {
    return readFileSync(filePath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-maximum)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw cause;
  }
}

function persistJsonLines<T>(filePath: string | undefined, entries: readonly T[]): void {
  if (filePath === undefined) return;
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, filePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Projection d'un run d'agent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ce qu'un run laisse voir.
 *
 * Comparer avec `AgentRunRecord` est instructif : il n'y a **pas** de champ
 * `messages`, pas de `providerBlocks`, pas de transcript. Ce type est la
 * frontière, et le fait qu'il soit plus pauvre que la source est le but.
 */
export interface AgentRunView {
  runId: string;
  userId: string;
  conversationId: string;
  correlationId: string;
  status: string;
  stopReason: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  iterations: number;
  /** Réponse finale rendue à l'utilisateur. Un résultat, pas un raisonnement. */
  response: string | null;
  tools: {
    callId: string;
    tool: string;
    riskLevel: string;
    status: string;
    durationMs: number;
    attempts: number;
    /** Résumé rédigé et borné des arguments. Jamais l'objet complet. */
    action: string;
    errorCode: string | null;
  }[];
  errors: { at: string; code: string; message: string; iteration: number }[];
  metrics: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    toolCalls: number;
    failedToolCalls: number;
  };
}

/**
 * Forme minimale d'un run, telle que la projection la lit.
 *
 * Structurelle, et volontairement réduite à `record` : `@nexus/agent-core` n'est
 * pas importé ici, et surtout **`messages` n'apparaît nulle part**. La garantie
 * de non-divulgation du raisonnement n'est pas une politique appliquée au
 * passage, c'est la forme de cette signature.
 */
export interface ProjectableRun {
  record: {
    runId: string;
    userId: string;
    conversationId: string;
    correlationId: string;
    startTime: string;
    endTime: string | null;
    status: string;
    stopReason: string | null;
    iterations: number;
    model: string;
    response: string | null;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    toolsUsed: readonly {
      toolCallId: string;
      name: string;
      riskLevel: string;
      status: string;
      durationMs: number;
      attempts: number;
      input: unknown;
      errorCode?: string;
    }[];
    errors: readonly { at: string; code: string; message: string; iteration: number }[];
  };
}

export function projectAgentRun(run: ProjectableRun): AgentRunView {
  const { record } = run;
  const failed = record.toolsUsed.filter((tool) => tool.status !== "success").length;

  return {
    runId: record.runId,
    userId: record.userId,
    conversationId: record.conversationId,
    correlationId: record.correlationId,
    status: record.status,
    stopReason: record.stopReason,
    startedAt: record.startTime,
    endedAt: record.endTime,
    durationMs:
      record.endTime === null
        ? null
        : new Date(record.endTime).getTime() - new Date(record.startTime).getTime(),
    iterations: record.iterations,
    response: record.response,
    tools: record.toolsUsed.map((tool) => ({
      callId: tool.toolCallId,
      tool: tool.name,
      riskLevel: tool.riskLevel,
      status: tool.status,
      durationMs: tool.durationMs,
      attempts: tool.attempts,
      action: summarizeArguments(tool.input),
      errorCode: tool.errorCode ?? null,
    })),
    errors: record.errors.map((error) => ({ ...error })),
    metrics: {
      model: record.model,
      inputTokens: record.usage.inputTokens,
      outputTokens: record.usage.outputTokens,
      cacheReadTokens: record.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: record.usage.cacheWriteTokens ?? 0,
      toolCalls: record.toolsUsed.length,
      failedToolCalls: failed,
    },
  };
}

/**
 * Résumé d'un appel d'outil.
 *
 * Un nom d'outil seul ne suffit pas à superviser : « terminal.execute » ne dit
 * pas quelle commande a tourné. On rend donc une ligne, mais **rédigée puis
 * bornée** — la trace du run rédige déjà ses arguments, et rédiger une seconde
 * fois ici ne coûte rien pour un chemin de sortie qui, lui, est public.
 */
export function summarizeArguments(input: unknown): string {
  if (input === null || input === undefined) return "";

  const safe = redact(input);
  const text = typeof safe === "string" ? safe : JSON.stringify(safe);

  return truncate(text ?? "", 200);
}
