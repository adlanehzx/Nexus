import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { BrowserWorkerClient } from "@nexus/browser-client";
import type { BrowserEvent, BrowserIntent, BrowserTask } from "@nexus/browser-client";
import type { RiskLevel } from "@nexus/tools";
import { BrowserTaskFailedError, HumanVerificationRequiredError } from "../errors.js";
import type { SessionPool } from "../runtime/session-pool.js";

/**
 * Les capacités `browser.*` de l'exécutant navigateur.
 *
 * ## Une capacité par intention, jamais une capacité générique
 *
 * C'est le point de sécurité du fichier. Lire le prix d'un billet et acheter ce
 * billet sont techniquement le même geste — un clic — mais ce ne sont pas les
 * mêmes actes. Les séparer en quatre capacités distinctes est ce qui permet au
 * reste de NEXUS de faire son travail sans rien savoir du navigateur :
 *
 *  - `PermissionService` exige `browser.purchase` pour acheter, et l'utilisateur
 *    voit cette ligne dans ses réglages ;
 *  - `ConfirmationBroker` demande l'accord humain à partir du niveau de risque ;
 *  - `DeviceSelector` n'envoie une étape qu'à un appareil qui l'a annoncée.
 *
 * Le nom de la capacité **est** le nom de la permission (`permissionForCapability`
 * est l'identité). Un seul espace de nommage traverse le système, des réglages
 * de l'utilisateur jusqu'à l'action dans la page.
 *
 * ## Ce que ce fichier ne fait pas
 *
 * Il ne pilote aucun navigateur. Il traduit une capacité NEXUS en appel au
 * worker Python, qui détient `browser-use` et Chromium (ADR-006). La
 * restriction réelle des actions — un `read` ne peut pas cliquer, `evaluate`
 * n'existe pour personne — est appliquée **là-bas**, dans `policies.py`, parce
 * qu'un cœur compromis ne doit pas pouvoir transformer une lecture en achat.
 *
 * Il n'y a donc pas de politique dupliquée ici, et c'est délibéré : deux
 * politiques finissent toujours par diverger, et c'est la plus permissive qui
 * gagne.
 */

/**
 * Arguments d'une tâche de navigation.
 *
 * Identiques pour les quatre capacités : ce qui les distingue est l'intention,
 * pas la forme de l'appel.
 */
export const browseInputSchema = z.object({
  /** Ce qu'il faut obtenir, en langage naturel. */
  instructions: z.string().min(3).max(4_000),
  /**
   * Point de départ. Sans lui, les instructions doivent dire où aller.
   *
   * **`http` et `https` uniquement.** `new URL()` accepte n'importe quel
   * schéma : `javascript:`, `file:`, `data:`. Aucun n'a de sens ici, et le
   * premier est une exécution de code déguisée en adresse. On les refuse avant
   * qu'ils ne voyagent jusqu'au navigateur.
   */
  url: z
    .string()
    .url()
    .refine(
      (value) => {
        const protocol = URL.parse(value)?.protocol;
        return protocol === "http:" || protocol === "https:";
      },
      { message: "seuls http:// et https:// sont acceptés" },
    )
    .optional(),
  /**
   * Étapes maximales.
   *
   * Plafonné par la configuration de l'hôte : une tâche qui boucle coûte des
   * appels au modèle et tient un Chromium ouvert.
   */
  maxSteps: z.number().int().min(1).max(50).optional(),
});

export type BrowseInput = z.infer<typeof browseInputSchema>;

export interface BrowseResult {
  /** Ce que la navigation a produit, en texte. */
  output: string;
  status: string;
  steps: number;
  durationMs: number;
  /** Dernière URL réellement visitée, quand il y en a eu une. */
  visitedUrl: string | null;
  /** Session navigateur utilisée — utile pour enchaîner dans la même tâche. */
  sessionId: string;
}

export interface BrowseDependencies {
  client: BrowserWorkerClient;
  sessions: SessionPool;
  maxSteps: number;
}

interface IntentSpec {
  capability: string;
  intent: BrowserIntent;
  riskLevel: RiskLevel;
  description: string;
}

/**
 * Les quatre intentions, et les capacités qui leur correspondent.
 *
 * `browser.navigate` et `browser.interact` figurent déjà au catalogue de
 * permissions du cœur et dans `DEFAULT_CAPABILITIES.BROWSER_WORKER`. `login` et
 * `purchase` prolongent la même série : elles sont déclarées par
 * `INTENT_PERMISSIONS` du client navigateur depuis l'origine.
 */
export const BROWSER_INTENTS: readonly IntentSpec[] = [
  {
    capability: "browser.navigate",
    intent: "read",
    riskLevel: "LOW",
    description:
      "Ouvre une page web et en extrait de l'information : prix, horaires, disponibilité, contenu. " +
      "LECTURE SEULE — ne clique pas, ne remplit aucun formulaire, ne se connecte à rien. " +
      "À utiliser pour toute recherche d'information sur le web.",
  },
  {
    capability: "browser.interact",
    intent: "interact",
    riskLevel: "MEDIUM",
    description:
      "Interagit avec une page web : cliquer, remplir un formulaire, filtrer, rechercher. " +
      "N'effectue ni connexion ni paiement.",
  },
  {
    capability: "browser.login",
    intent: "login",
    riskLevel: "HIGH",
    description:
      "Se connecte à un site avec des identifiants déjà enregistrés par l'utilisateur. " +
      "Ne contourne JAMAIS un CAPTCHA ni une authentification à deux facteurs : si le site en " +
      "demande une, la tâche s'arrête et rend la main à l'utilisateur.",
  },
  {
    capability: "browser.purchase",
    intent: "purchase",
    riskLevel: "CRITICAL",
    description:
      "Finalise un achat ou une réservation payante. Action IRRÉVERSIBLE et engageante " +
      "financièrement. À n'utiliser qu'après avoir présenté le montant exact et obtenu l'accord " +
      "explicite de l'utilisateur.",
  },
];

/** Construit les quatre capacités de navigation. */
export function createBrowseCapabilities(
  dependencies: BrowseDependencies,
): LocalCapability<BrowseInput, BrowseResult>[] {
  return BROWSER_INTENTS.map((spec) => createBrowseCapability(spec, dependencies));
}

function createBrowseCapability(
  spec: IntentSpec,
  dependencies: BrowseDependencies,
): LocalCapability<BrowseInput, BrowseResult> {
  return {
    name: spec.capability,
    description: spec.description,
    version: "1",
    inputSchema: browseInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        instructions: {
          type: "string",
          description: "Ce qu'il faut obtenir, en langage naturel",
        },
        url: { type: "string", description: "Page de départ" },
        maxSteps: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["instructions"],
    },
    riskLevel: spec.riskLevel,

    /**
     * Le worker Python répond-il ?
     *
     * Une capacité annoncée qu'on ne peut pas honorer est pire que pas de
     * capacité du tout : le sélecteur choisirait cet exécutant et l'étape
     * échouerait après avoir écarté quelqu'un qui, lui, aurait su faire.
     */
    probe: async (): Promise<boolean> => {
      try {
        await dependencies.client.health();
        return true;
      } catch {
        return false;
      }
    },

    execute: async (input, context): Promise<BrowseResult> => {
      // Une session par tâche NEXUS : deux tâches ne partagent jamais de
      // cookies, d'onglets ni d'historique. Les étapes successives d'une même
      // tâche, elles, la réutilisent — sans quoi « connecte-toi puis
      // commande » ouvrirait deux navigateurs et perdrait la session.
      const sessionId = await dependencies.sessions.acquire(context.taskId, context.signal);

      const instructions =
        input.url === undefined
          ? input.instructions
          : `Va sur ${input.url}, puis : ${input.instructions}`;

      const started = await dependencies.client.runTask(
        {
          // L'identifiant d'étape rend le lancement idempotent : un renvoi
          // après coupure ne relance pas une seconde navigation.
          taskId: `${context.taskId}-${context.stepId}`.slice(0, 120),
          sessionId,
          instructions,
          intent: spec.intent,
          maxSteps: Math.min(input.maxSteps ?? dependencies.maxSteps, dependencies.maxSteps),
        },
        context.signal,
      );

      let visitedUrl: string | null = null;

      const finished = await dependencies.client.waitForTask(started.taskId, {
        signal: context.signal,
        onEvent: (event) => {
          if (event.type === "navigation") visitedUrl = event.url;
          const progress = describeEvent(event);
          if (progress !== undefined) context.onProgress(progress);
        },
      });

      return finalize(spec, finished, sessionId, visitedUrl);
    },
  };
}

/**
 * Traduit l'issue d'une tâche navigateur en résultat de capacité.
 *
 * Trois issues, trois traitements distincts — et surtout, `needs_human` n'est
 * **pas** un échec.
 */
function finalize(
  spec: IntentSpec,
  task: BrowserTask,
  sessionId: string,
  visitedUrl: string | null,
): BrowseResult {
  if (task.status === "needs_human") {
    // Le site demande une vérification humaine. On ne la contourne pas : on
    // s'arrête et on rend la main, avec un message rédigé pour être relayé tel
    // quel à l'utilisateur. Ce worker ne contient aucun code de résolution de
    // CAPTCHA et n'en contiendra pas.
    throw new HumanVerificationRequiredError(
      spec.capability,
      task.error?.message ??
        "Le site demande une vérification humaine (CAPTCHA ou authentification à deux " +
          "facteurs). Je ne la contourne pas : prends la main sur cette étape, puis " +
          "redemande-moi de continuer.",
    );
  }

  if (task.status !== "succeeded") {
    throw new BrowserTaskFailedError(spec.capability, {
      status: task.status,
      code: task.error?.code,
      message: task.error?.message,
      retryable: task.error?.retryable ?? false,
    });
  }

  return {
    output: task.output ?? "",
    status: task.status,
    steps: task.steps,
    durationMs: task.durationMs ?? 0,
    visitedUrl,
    sessionId,
  };
}

/**
 * Traduit un événement du worker en progression lisible.
 *
 * Ce qui remonte au cœur est **ce que fait l'agent**, pas ce qu'il pense en
 * détail : une étape, une page ouverte, une action. Le raisonnement interne du
 * modèle est tronqué à cent vingt caractères — assez pour suivre, pas assez
 * pour exposer une chaîne de pensée complète dans le journal du tableau de bord.
 */
function describeEvent(event: BrowserEvent): { percent?: number; label?: string } | undefined {
  switch (event.type) {
    case "navigation":
      return { label: `Ouverture de ${hostOf(event.url)}` };
    case "action":
      return { label: `${event.action}${event.target === null ? "" : ` : ${event.target}`}` };
    case "thinking":
      return { label: event.text.slice(0, 120) };
    case "progress":
      return {
        label: `Étape ${String(event.step)}/${String(event.maxSteps)}`,
        percent: Math.round((event.step / event.maxSteps) * 100),
      };
    default:
      return undefined;
  }
}

function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url.slice(0, 60);
}
