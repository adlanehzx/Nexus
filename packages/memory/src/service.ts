import { AppError, type ErrorSeverity } from "@nexus/shared";
import { classify, safePreview } from "./sensitivity.js";
import { parseMemoryCommand, type MemoryCommand } from "./commands.js";
import type {
  MemoryHit,
  MemoryProvider,
  MemorySearchQuery,
  MemoryUpdateInput,
} from "./provider.js";
import type { MemoryKind, MemoryOrigin, MemoryRecord, StorableLayer } from "./types.js";

/**
 * Le service de mémoire.
 *
 * `MemoryProvider` est un magasin : il range et il retrouve. Ce service est la
 * **politique** qui l'entoure, et c'est lui que l'API et le cœur agent appellent
 * — jamais le magasin directement. Trois choses n'existent qu'ici :
 *
 *  1. **La règle du silence.** Rien de sensible n'est mémorisé sans que
 *     quelqu'un l'ait su. Un secret est refusé ; une information personnelle
 *     exige un accord explicite. Le magasin, lui, écrirait tout ce qu'on lui
 *     donne — c'est son rôle, et c'est pourquoi il ne doit pas être appelé nu.
 *
 *  2. **Les commandes explicites.** « Retiens que… », « Oublie… ».
 *
 *  3. **La frontière entre utilisateurs**, appliquée une fois, ici, plutôt que
 *     répétée dans chaque route.
 *
 * Une conséquence de forme : ce service ne connaît ni HTTP, ni WebSocket, ni
 * React. L'iPhone, le portable et l'agent l'atteignent par des chemins
 * différents et obtiennent exactement le même comportement.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs
// ─────────────────────────────────────────────────────────────────────────────

export class SensitiveMemoryRefusedError extends AppError {
  readonly code = "MEMORY_SENSITIVE_REFUSED";
  readonly httpStatus = 422;
  override readonly severity: ErrorSeverity = "warning";

  constructor(explanation: string, categories: readonly string[], preview: string) {
    super({
      message: `Mémorisation refusée : ${categories.join(", ")}`,
      userMessage: explanation,
      // Le contexte porte les **catégories** et un aperçu masqué, jamais le
      // contenu : une erreur finit dans un journal, et refuser de stocker un
      // secret pour le recopier dans la trace n'aurait aucun sens.
      context: { categories: [...categories], preview },
    });
  }
}

export class SensitiveMemoryNeedsConsentError extends AppError {
  readonly code = "MEMORY_CONSENT_REQUIRED";
  readonly httpStatus = 409;
  override readonly severity: ErrorSeverity = "warning";

  constructor(explanation: string, categories: readonly string[]) {
    super({
      message: `Accord explicite requis : ${categories.join(", ")}`,
      userMessage: explanation,
      context: { categories: [...categories] },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface RememberInput {
  userId: string;
  content: string;
  layer?: StorableLayer;
  kind?: MemoryKind;
  origin?: MemoryOrigin;
  importance?: number;
  confidence?: number;
  tags?: readonly string[];
  sourceRunId?: string;
  /**
   * L'utilisateur a vu la nature du contenu et l'a confirmé.
   *
   * **Le client ne pose ce drapeau qu'après avoir posé la question.** Le mettre
   * par défaut viderait la règle de son sens ; c'est pourquoi il n'a pas de
   * valeur par défaut à `true` nulle part dans le dépôt.
   */
  acknowledgedSensitive?: boolean;
}

export interface ForgetInput {
  userId: string;
  /** Identifiant exact. Prioritaire sur `match`. */
  id?: string;
  /** Texte à retrouver. Le chemin de « Oublie ce que je t'ai dit sur X ». */
  match?: string;
  /** Efface tout. Exige `confirmed`. */
  all?: boolean;
  confirmed?: boolean;
}

export interface ForgetResult {
  forgotten: MemoryRecord[];
  /**
   * Candidats trouvés mais **non supprimés**, faute de certitude.
   *
   * Quand plusieurs souvenirs correspondent, on ne devine pas : on les rend, et
   * l'utilisateur tranche. Supprimer le mauvais est irréversible ; demander
   * coûte un aller-retour.
   */
  ambiguous: MemoryRecord[];
  /** Vrai quand un effacement total a été demandé sans confirmation. */
  needsConfirmation: boolean;
}

export interface CommandOutcome {
  command: MemoryCommand;
  stored?: MemoryRecord;
  forgotten?: ForgetResult;
  /** Phrase affichable, destinée à l'utilisateur. */
  message: string;
}

export interface MemoryServiceOptions {
  provider: MemoryProvider;
  now?: () => Date;
  /**
   * Journalisation d'audit.
   *
   * Reçoit ce qui s'est passé, **jamais le contenu**. Savoir qu'un souvenir
   * sensible a été refusé est utile ; le recopier dans le journal annulerait le
   * refus.
   */
  onAudit?: (event: {
    action: "store" | "update" | "delete" | "refuse" | "consent-required";
    userId: string;
    recordId?: string;
    categories?: readonly string[];
  }) => void;
}

export class MemoryService {
  readonly #provider: MemoryProvider;
  readonly #onAudit: MemoryServiceOptions["onAudit"];

  constructor(options: MemoryServiceOptions) {
    this.#provider = options.provider;
    this.#onAudit = options.onAudit;
  }

  // ── Écriture ────────────────────────────────────────────────────────────

  /**
   * Mémorise, sous conditions.
   *
   * @throws {SensitiveMemoryRefusedError} contenu qui ne doit jamais être
   *   stocké — secret d'authentification, moyen de paiement.
   * @throws {SensitiveMemoryNeedsConsentError} contenu personnel présenté sans
   *   accord explicite. L'appelant montre l'explication, demande, et rappelle
   *   avec `acknowledgedSensitive`.
   */
  async remember(input: RememberInput): Promise<MemoryRecord> {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new SensitiveMemoryRefusedError("Il n'y a rien à mémoriser.", ["contenu-vide"], "");
    }

    const verdict = classify(content);

    if (verdict.verdict === "FORBIDDEN") {
      this.#onAudit?.({
        action: "refuse",
        userId: input.userId,
        categories: verdict.categories,
      });
      throw new SensitiveMemoryRefusedError(
        verdict.explanation,
        verdict.categories,
        safePreview(content),
      );
    }

    if (verdict.verdict === "PERSONAL" && input.acknowledgedSensitive !== true) {
      this.#onAudit?.({
        action: "consent-required",
        userId: input.userId,
        categories: verdict.categories,
      });
      throw new SensitiveMemoryNeedsConsentError(verdict.explanation, verdict.categories);
    }

    const record = await this.#provider.store({
      userId: input.userId,
      kind: input.kind ?? "SEMANTIC",
      content,
      layer: input.layer ?? "LONG_TERM",
      origin: input.origin ?? "USER",
      sensitivity: verdict.verdict === "PERSONAL" ? "PERSONAL" : "ORDINARY",
      sensitiveCategories: verdict.categories,
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
    });

    this.#onAudit?.({ action: "store", userId: input.userId, recordId: record.id });
    return record;
  }

  /**
   * Corrige un souvenir.
   *
   * Le contenu révisé repasse par la classification. Un souvenir anodin qu'on
   * édite pour y glisser un mot de passe doit être refusé comme s'il était neuf ;
   * ne contrôler qu'à la création laisserait la modification comme porte ouverte.
   */
  async update(
    input: MemoryUpdateInput & { acknowledgedSensitive?: boolean },
  ): Promise<MemoryRecord | undefined> {
    if (input.content !== undefined) {
      const verdict = classify(input.content);

      if (verdict.verdict === "FORBIDDEN") {
        this.#onAudit?.({
          action: "refuse",
          userId: input.userId,
          recordId: input.id,
          categories: verdict.categories,
        });
        throw new SensitiveMemoryRefusedError(
          verdict.explanation,
          verdict.categories,
          safePreview(input.content),
        );
      }

      if (verdict.verdict === "PERSONAL" && input.acknowledgedSensitive !== true) {
        throw new SensitiveMemoryNeedsConsentError(verdict.explanation, verdict.categories);
      }
    }

    const { acknowledgedSensitive: _ack, ...patch } = input;
    const updated = await this.#provider.update(patch);

    if (updated !== undefined) {
      this.#onAudit?.({ action: "update", userId: input.userId, recordId: updated.id });
    }
    return updated;
  }

  // ── Oubli ───────────────────────────────────────────────────────────────

  /**
   * Oublie.
   *
   * Trois chemins, du plus sûr au plus large :
   *
   *  - par **identifiant** : sans ambiguïté, c'est ce que fait l'écran de
   *    gestion ;
   *  - par **texte** : on cherche, et on ne supprime que si la réponse est
   *    unique. Deux candidats rendent la main à l'utilisateur plutôt que de
   *    parier ;
   *  - **tout**, et seulement sur confirmation explicite. Un souvenir effacé se
   *    redit ; une mémoire entière ne se reconstitue pas.
   */
  async forget(input: ForgetInput): Promise<ForgetResult> {
    if (input.all === true) {
      if (input.confirmed !== true) {
        return { forgotten: [], ambiguous: [], needsConfirmation: true };
      }

      const all = await this.#provider.search({
        userId: input.userId,
        query: "",
        limit: 10_000,
        includeSuperseded: true,
      });

      const forgotten: MemoryRecord[] = [];
      for (const hit of all) {
        if (await this.#provider.delete({ userId: input.userId, id: hit.record.id })) {
          forgotten.push(hit.record);
        }
      }

      this.#onAudit?.({ action: "delete", userId: input.userId });
      return { forgotten, ambiguous: [], needsConfirmation: false };
    }

    if (input.id !== undefined) {
      // On relit avant de supprimer : rendre l'enregistrement effacé permet à
      // l'interface d'afficher *ce qui* a disparu, et d'offrir de le redire.
      const found = await this.#provider.search({
        userId: input.userId,
        query: "",
        limit: 10_000,
        includeSuperseded: true,
      });
      const record = found.find((hit) => hit.record.id === input.id)?.record;

      const deleted = await this.#provider.delete({ userId: input.userId, id: input.id });
      if (deleted) this.#onAudit?.({ action: "delete", userId: input.userId, recordId: input.id });

      return {
        forgotten: deleted && record !== undefined ? [record] : [],
        ambiguous: [],
        needsConfirmation: false,
      };
    }

    const match = input.match?.trim() ?? "";
    if (match.length === 0) return { forgotten: [], ambiguous: [], needsConfirmation: false };

    const hits = await this.#provider.search({ userId: input.userId, query: match, limit: 5 });

    if (hits.length === 0) return { forgotten: [], ambiguous: [], needsConfirmation: false };

    // Une correspondance nettement meilleure que la suivante tranche ; sinon on
    // demande. Le seuil est un choix : au-delà, deviner devient risqué.
    const best = hits[0];
    const second = hits[1];
    const clear = best !== undefined && (second === undefined || best.score - second.score >= 0.2);

    if (!clear) {
      return { forgotten: [], ambiguous: hits.map((hit) => hit.record), needsConfirmation: false };
    }

    const deleted = await this.#provider.delete({ userId: input.userId, id: best.record.id });
    if (deleted) {
      this.#onAudit?.({ action: "delete", userId: input.userId, recordId: best.record.id });
    }

    return {
      forgotten: deleted ? [best.record] : [],
      ambiguous: [],
      needsConfirmation: false,
    };
  }

  // ── Lecture ─────────────────────────────────────────────────────────────

  search(query: MemorySearchQuery): Promise<MemoryHit[]> {
    return this.#provider.search(query);
  }

  /** Tout ce que NEXUS retient, du plus récent au plus ancien. */
  list(input: { userId: string; layer?: StorableLayer; limit?: number }): Promise<MemoryHit[]> {
    return this.#provider.search({
      userId: input.userId,
      query: "",
      ...(input.layer === undefined ? {} : { layers: [input.layer] }),
      limit: input.limit ?? 100,
    });
  }

  summarize(input: { userId: string; text: string; maxChars?: number }): Promise<string> {
    return this.#provider.summarize(input);
  }

  // ── Commandes explicites ────────────────────────────────────────────────

  /**
   * Exécute « Retiens que… » ou « Oublie… » s'il y en a une.
   *
   * Rend `undefined` quand le message n'est pas une commande — c'est-à-dire
   * presque toujours. L'appelant poursuit alors son traitement normal.
   *
   * Une commande de mémorisation traverse **exactement** la même classification
   * qu'un appel d'API : l'utilisateur qui dicte son mot de passe se le voit
   * refuser comme s'il l'avait saisi dans l'écran de gestion.
   */
  async handleCommand(
    userId: string,
    text: string,
    options: { acknowledgedSensitive?: boolean; confirmedForgetAll?: boolean } = {},
  ): Promise<CommandOutcome | undefined> {
    const command = parseMemoryCommand(text);
    if (command === undefined) return undefined;

    if (command.kind === "remember") {
      const stored = await this.remember({
        userId,
        content: command.content,
        origin: "USER",
        // Ce que l'utilisateur dicte lui-même compte davantage qu'une inférence.
        importance: 0.8,
        confidence: 0.95,
        ...(options.acknowledgedSensitive === undefined
          ? {}
          : { acknowledgedSensitive: options.acknowledgedSensitive }),
      });

      return { command, stored, message: `C'est noté : ${stored.content}` };
    }

    const forgotten = await this.forget({
      userId,
      ...(command.all ? { all: true } : { match: command.target }),
      ...(options.confirmedForgetAll === undefined
        ? {}
        : { confirmed: options.confirmedForgetAll }),
    });

    return { command, forgotten, message: describeForget(forgotten) };
  }
}

function describeForget(result: ForgetResult): string {
  if (result.needsConfirmation) {
    return "Effacer toute la mémoire est irréversible. Confirmez pour continuer.";
  }
  if (result.ambiguous.length > 0) {
    return `Plusieurs souvenirs correspondent (${String(result.ambiguous.length)}). Lequel dois-je oublier ?`;
  }
  if (result.forgotten.length === 0) {
    return "Je n'ai rien trouvé qui corresponde.";
  }
  if (result.forgotten.length === 1) {
    return `Oublié : ${result.forgotten[0]?.content ?? ""}`;
  }
  return `${String(result.forgotten.length)} souvenirs oubliés.`;
}
