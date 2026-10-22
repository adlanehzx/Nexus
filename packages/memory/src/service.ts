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
import { memoryContentHash } from "./embedding.js";

/**
 * Memory service.
 *
 * `MemoryProvider` is a storage engine: it stores and retrieves records.
 * This service embodies the surrounding **policy**, consumed by the API and agent core.
 * Three responsibilities reside exclusively here:
 *
 *  1. **The silence rule.** Nothing sensitive is stored silently without user awareness.
 *     Prohibited secrets are rejected; personal data requires explicit confirmation.
 *     The raw store does not inspect content semantics — hence it is never called directly.
 *
 *  2. **Explicit natural-language commands.** "Remember that...", "Forget...".
 *
 *  3. **User boundary enforcement.** Applied centrally here rather than duplicated across routes.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class SensitiveMemoryRefusedError extends AppError {
  readonly code = "MEMORY_SENSITIVE_REFUSED";
  readonly httpStatus = 422;
  override readonly severity: ErrorSeverity = "warning";

  constructor(explanation: string, categories: readonly string[], preview: string) {
    super({
      message: `Memory storage refused: ${categories.join(", ")}`,
      userMessage: explanation,
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
      message: `Explicit consent required: ${categories.join(", ")}`,
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
  sourceConversationId?: string;
  sourceMessageId?: string;
  sourceUri?: string;
  extractedAt?: Date;
  /**
   * Indicates the user has reviewed sensitive content and confirmed storage.
   */
  acknowledgedSensitive?: boolean;
}

export interface ForgetInput {
  userId: string;
  /** Exact record identifier. Takes precedence over `match`. */
  id?: string;
  /** Text search query matching items to forget. */
  match?: string;
  /** Purge all memory items. Requires `confirmed: true`. */
  all?: boolean;
  confirmed?: boolean;
}

export interface ForgetResult {
  forgotten: MemoryRecord[];
  /**
   * Ambiguous candidates discovered but not purged to prevent accidental deletion.
   */
  ambiguous: MemoryRecord[];
  /** True when a total purge is requested without confirmation. */
  needsConfirmation: boolean;
}

export interface CommandOutcome {
  command: MemoryCommand;
  stored?: MemoryRecord;
  forgotten?: ForgetResult;
  /** User-facing display response. */
  message: string;
}

export interface MemoryServiceOptions {
  provider: MemoryProvider;
  now?: () => Date;
  /**
   * Audit log receiver.
   *
   * Receives action metadata and categories, never raw secret content.
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

  // ── Write ───────────────────────────────────────────────────────────────

  /**
   * Stores a memory under policy evaluation.
   *
   * @throws {SensitiveMemoryRefusedError} Prohibited secrets (credentials, payment cards).
   * @throws {SensitiveMemoryNeedsConsentError} Personal info submitted without explicit confirmation.
   */
  async remember(input: RememberInput): Promise<MemoryRecord> {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new SensitiveMemoryRefusedError("There is nothing to remember.", ["empty-content", "contenu-vide"], "");
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

    // Deduplicate identical content hash prior to storage.
    const contentHash = memoryContentHash(content);
    const existing = await this.#provider.search({
      userId: input.userId,
      query: content,
      layers: [input.layer ?? "LONG_TERM"],
      limit: 50,
    });
    const duplicate = existing.find((hit) => hit.record.contentHash === contentHash)?.record;
    if (duplicate !== undefined) return duplicate;

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
      ...(input.sourceConversationId === undefined
        ? {}
        : { sourceConversationId: input.sourceConversationId }),
      ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
      ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
      ...(input.extractedAt === undefined ? {} : { extractedAt: input.extractedAt }),
    });

    this.#onAudit?.({ action: "store", userId: input.userId, recordId: record.id });
    return record;
  }

  /**
   * Updates an existing memory record.
   *
   * Content changes re-trigger classification to prevent sneaking secrets via edits.
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

  // ── Forget ──────────────────────────────────────────────────────────────

  /**
   * Purges memories according to specified criteria:
   *  - by `id`: unambiguous removal;
   *  - by `match`: search and purge only if match is unique (avoids accidental deletion);
   *  - `all`: total wipe requiring explicit confirmation.
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

  // ── Read ────────────────────────────────────────────────────────────────

  search(query: MemorySearchQuery): Promise<MemoryHit[]> {
    return this.#provider.search(query);
  }

  /** Lists memories ordered newest to oldest. */
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

  // ── Explicit commands ───────────────────────────────────────────────────

  /**
   * Executes explicit commands ("Remember that...", "Forget...").
   *
   * Returns `undefined` if text is not a recognizable command.
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
        importance: 0.8,
        confidence: 0.95,
        ...(options.acknowledgedSensitive === undefined
          ? {}
          : { acknowledgedSensitive: options.acknowledgedSensitive }),
      });

      return { command, stored, message: `Noted: ${stored.content}` };
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
    return "Clearing all memory is irreversible. Please confirm to continue.";
  }
  if (result.ambiguous.length > 0) {
    return `Multiple memories match (${String(result.ambiguous.length)}). Which one should I forget?`;
  }
  if (result.forgotten.length === 0) {
    return "I found nothing matching.";
  }
  if (result.forgotten.length === 1) {
    return `Forgotten: ${result.forgotten[0]?.content ?? ""}`;
  }
  return `${String(result.forgotten.length)} memories forgotten.`;
}
