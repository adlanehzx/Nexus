import type { MemoryProvider } from "./provider.js";
import type { ShortTermContext } from "./short-term.js";
import type { ConversationHistoryPort, DeviceContextPort, TaskHistoryPort } from "./sources.js";

/**
 * Assemblage du contexte.
 *
 * C'est ici que les six couches se rejoignent — et le point de ce module est
 * qu'elles s'y rejoignent **sans se mélanger**. Chaque source garde sa section,
 * son budget et son propriétaire ; aucune ne peut affamer les autres.
 *
 * Le budget par section est la décision centrale. Un budget global unique
 * paraît plus simple et se comporte mal : une conversation longue mange tout, et
 * les préférences de l'utilisateur — trois lignes qui changent la réponse —
 * tombent en dernier parce qu'elles arrivent en dernier. Découper garantit qu'un
 * historique bavard ne fait pas oublier à NEXUS que l'utilisateur préfère le
 * train.
 *
 * L'ordre est un ordre de **priorité**, pas de lecture : les sections servies en
 * premier sont celles qui changent la réponse même quand tout le reste manque.
 *
 *     1. préférences      ce que l'utilisateur a demandé une fois pour toutes
 *     2. contexte courant ce que cette session a établi
 *     3. souvenirs        ce que NEXUS sait de lui
 *     4. appareils        ce qu'il peut faire, et où
 *     5. tâches récentes  ce qui vient de se passer
 *     6. historique       le reste de la conversation
 *
 * **Le budget est compté en caractères, pas en tokens.** Compter des tokens
 * exigerait le tokeniseur du fournisseur, donc une dépendance au modèle dans un
 * paquet qui n'en a aucune. Le caractère est un substitut stable, et ce budget
 * est une barrière — pas une comptabilité.
 */

export interface ContextBudget {
  preferences: number;
  shortTerm: number;
  longTerm: number;
  devices: number;
  tasks: number;
  conversation: number;
}

/**
 * Budget par défaut : environ 6 000 caractères.
 *
 * Les préférences ont peu de place parce qu'elles en demandent peu ; la
 * conversation en a le plus parce qu'elle est la seule à croître sans limite.
 */
export const DEFAULT_BUDGET: ContextBudget = {
  preferences: 600,
  shortTerm: 800,
  longTerm: 1_500,
  devices: 600,
  tasks: 800,
  conversation: 1_700,
};

export type ContextSectionName =
  "preferences" | "shortTerm" | "longTerm" | "devices" | "tasks" | "conversation";

export interface ContextSection {
  name: ContextSectionName;
  title: string;
  lines: string[];
  chars: number;
  /** Éléments écartés faute de place. Affiché nulle part, utile au diagnostic. */
  dropped: number;
}

export interface AssembledContext {
  sections: ContextSection[];
  /** Le bloc prêt à joindre aux instructions système. */
  text: string;
  chars: number;
}

export interface ContextAssemblerOptions {
  memory: MemoryProvider;
  shortTerm?: ShortTermContext;
  conversation?: ConversationHistoryPort;
  devices?: DeviceContextPort;
  tasks?: TaskHistoryPort;
  budget?: Partial<ContextBudget>;
}

export interface AssembleInput {
  userId: string;
  conversationId: string;
  /** Le tour courant. Sert de requête pour la recherche de souvenirs. */
  query: string;
}

const TITLES: Record<ContextSectionName, string> = {
  preferences: "Préférences de l'utilisateur",
  shortTerm: "Contexte de la session en cours",
  longTerm: "Ce que tu sais de cet utilisateur",
  devices: "Appareils disponibles",
  tasks: "Tâches récentes",
  conversation: "Plus tôt dans la conversation",
};

export class ContextAssembler {
  readonly #options: ContextAssemblerOptions;
  readonly #budget: ContextBudget;

  constructor(options: ContextAssemblerOptions) {
    this.#options = options;
    this.#budget = { ...DEFAULT_BUDGET, ...options.budget };
  }

  async assemble(input: AssembleInput): Promise<AssembledContext> {
    // Les six lectures partent ensemble : elles ne dépendent pas les unes des
    // autres, et les enchaîner ajouterait leurs latences pour rien.
    const [preferences, longTerm, conversation, devices, tasks] = await Promise.all([
      this.#preferences(input),
      this.#longTerm(input),
      this.#conversation(input),
      this.#devices(input),
      this.#tasks(input),
    ]);

    const sections = [
      preferences,
      this.#shortTerm(input),
      longTerm,
      devices,
      tasks,
      conversation,
    ].filter((section): section is ContextSection => section !== undefined);

    const text = sections
      .filter((section) => section.lines.length > 0)
      .map((section) => `## ${section.title}\n${section.lines.join("\n")}`)
      .join("\n\n");

    return { sections, text, chars: text.length };
  }

  // ── 4. Préférences ──────────────────────────────────────────────────────

  async #preferences(input: AssembleInput): Promise<ContextSection> {
    // Requête vide : **toutes** les préférences, pas celles qui ressemblent au
    // message. Une consigne permanente vaut quel que soit le sujet du jour —
    // « réponds toujours en français » ne doit pas disparaître parce qu'on parle
    // de Docker.
    const hits = await this.#options.memory.search({
      userId: input.userId,
      query: "",
      layers: ["PREFERENCE"],
      limit: 20,
    });

    return fit(
      "preferences",
      hits.map((hit) => `- ${hit.record.content}`),
      this.#budget.preferences,
    );
  }

  // ── 2. Contexte court terme ─────────────────────────────────────────────

  #shortTerm(input: AssembleInput): ContextSection {
    const notes = this.#options.shortTerm?.list(input.conversationId) ?? [];

    return fit(
      "shortTerm",
      notes.map((note) => `- ${note.key} : ${note.value}`),
      this.#budget.shortTerm,
    );
  }

  // ── 3. Mémoire longue durée ─────────────────────────────────────────────

  async #longTerm(input: AssembleInput): Promise<ContextSection> {
    const hits = await this.#options.memory.search({
      userId: input.userId,
      query: input.query,
      layers: ["LONG_TERM"],
      limit: 12,
    });

    return fit(
      "longTerm",
      // L'origine accompagne le fait. « L'utilisateur a dit » et « déduit d'une
      // conversation » n'ont pas la même autorité, et le modèle doit pouvoir
      // nuancer plutôt que d'affirmer une inférence comme une certitude.
      hits.map(
        (hit) => `- ${hit.record.content}${hit.record.origin === "AGENT" ? " (déduit)" : ""}`,
      ),
      this.#budget.longTerm,
    );
  }

  // ── 5. Appareils ────────────────────────────────────────────────────────

  async #devices(input: AssembleInput): Promise<ContextSection> {
    const devices = (await this.#options.devices?.devicesFor(input.userId)) ?? [];

    return fit(
      "devices",
      devices.map(
        (device) =>
          `- ${device.name} (${device.role}, ${device.status})` +
          (device.capabilities.length === 0 ? "" : ` : ${device.capabilities.join(", ")}`),
      ),
      this.#budget.devices,
    );
  }

  // ── 6. Historique des tâches ────────────────────────────────────────────

  async #tasks(input: AssembleInput): Promise<ContextSection> {
    const tasks =
      (await this.#options.tasks?.recentTasks({ userId: input.userId, limit: 10 })) ?? [];

    return fit(
      "tasks",
      tasks.map(
        (task) =>
          `- ${task.title} — ${task.status}` +
          (task.deviceName === null ? "" : ` sur ${task.deviceName}`),
      ),
      this.#budget.tasks,
    );
  }

  // ── 1. Historique de conversation ───────────────────────────────────────

  async #conversation(input: AssembleInput): Promise<ContextSection> {
    const turns =
      (await this.#options.conversation?.recentTurns({
        userId: input.userId,
        conversationId: input.conversationId,
        limit: 20,
      })) ?? [];

    // Les tours les plus **récents** priment : ce sont eux que la question
    // courante prolonge. On construit donc la liste à l'envers, puis on la
    // remet à l'endroit une fois le budget consommé.
    const lines = [...turns].reverse().map((turn) => `- ${turn.role} : ${collapse(turn.content)}`);

    const section = fit("conversation", lines, this.#budget.conversation);
    return { ...section, lines: [...section.lines].reverse() };
  }
}

/**
 * Remplit une section jusqu'à son budget.
 *
 * On coupe **entre les lignes**, jamais au milieu : une préférence tronquée à
 * mi-phrase peut changer de sens, et un modèle n'a aucun moyen de savoir qu'il
 * lui manque la fin.
 */
function fit(name: ContextSectionName, lines: string[], budget: number): ContextSection {
  const kept: string[] = [];
  let chars = 0;

  for (const line of lines) {
    if (chars + line.length + 1 > budget) break;
    kept.push(line);
    chars += line.length + 1;
  }

  return {
    name,
    title: TITLES[name],
    lines: kept,
    chars,
    dropped: lines.length - kept.length,
  };
}

/** Un tour de conversation sur une seule ligne, borné. */
function collapse(content: string): string {
  const single = content.replace(/\s+/g, " ").trim();
  return single.length <= 200 ? single : `${single.slice(0, 200)}…`;
}
