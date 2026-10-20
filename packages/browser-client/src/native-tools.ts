import { z } from "zod";
import type { ToolDefinition, ToolContext } from "@nexus/tools";
import type { BrowserSessionManager } from "./session-manager.js";
import { HumanInterventionRequiredError } from "./security-policy.js";

export interface NativeBrowserToolsOptions {
  sessionManager: BrowserSessionManager;
  captureScreenshotsOnNavigate?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

export function createNativeBrowserTools(options: NativeBrowserToolsOptions): AnyToolDefinition[] {
  const { sessionManager, captureScreenshotsOnNavigate = true } = options;
  const policy = sessionManager.policy;
  const driver = sessionManager.driver;

  function resolveSessionId(explicitSessionId?: string, context?: ToolContext): string {
    return explicitSessionId ?? context?.runId ?? "default";
  }

  // ── 1. browser.navigate ───────────────────────────────────────────────────
  const navigateInputSchema = z.object({
    url: z.string().min(1).describe("URL HTTP ou HTTPS complète vers laquelle naviguer"),
    sessionId: z
      .string()
      .optional()
      .describe("Identifiant de session de navigation (par défaut l'identifiant du run courant)"),
  });

  const navigateOutputSchema = z.object({
    url: z.string(),
    title: z.string(),
    status: z.literal("loaded"),
    screenshotArtifactId: z.string().optional(),
    humanInterventionRequired: z.boolean().optional(),
    humanInterventionReason: z.string().optional(),
  });

  const navigateTool: ToolDefinition<
    z.infer<typeof navigateInputSchema>,
    z.infer<typeof navigateOutputSchema>
  > = {
    name: "browser.navigate",
    description:
      "Navigue vers une URL web sécurisée (http ou https). Ouvre ou réutilise l'onglet dédié de la session, " +
      "attend la fin du chargement complet et prend une capture d'écran horodatée. Ne navigue jamais vers file:, chrome:, " +
      "ou des adresses IP locales protégées (SSRF).",
    riskLevel: "SAFE",
    requiredPermissions: ["browser.navigate"],
    requiresConfirmation: false,
    inputSchema: navigateInputSchema,
    outputSchema: navigateOutputSchema,
    summarize: (input) => `Navigation vers ${input.url}`,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input.sessionId, context);
      policy.assertUrlSafe(input.url);

      context.onProgress({ pct: 10, label: `Ouverture de session pour ${input.url}` });
      await sessionManager.getOrCreateSession(sessionId);
      sessionManager.recordAction(sessionId);

      context.onProgress({ pct: 40, label: `Chargement de ${input.url}` });
      const info = await driver.navigate(input.url);

      // Détection immédiate d'intervention humaine (CAPTCHA, MFA, etc.)
      const check = policy.detectHumanIntervention(info);
      if (check.required) {
        sessionManager.suspendForHumanIntervention(sessionId, check.reason!, info.url);
        throw new HumanInterventionRequiredError(check.reason!, info.url);
      }

      let screenshotArtifactId: string | undefined;
      if (captureScreenshotsOnNavigate) {
        try {
          context.onProgress({ pct: 80, label: "Capture d'écran de confirmation" });
          const shot = await driver.screenshot();
          const artifact = await sessionManager.saveScreenshotArtifact(
            sessionId,
            shot.filePath,
            info,
          );
          screenshotArtifactId = artifact.id;
        } catch {
          // La capture d'écran est non bloquante si la navigation a réussi
        }
      }

      context.onProgress({ pct: 100, label: `Page chargée : ${info.title}` });
      return {
        url: info.url,
        title: info.title,
        status: "loaded" as const,
        screenshotArtifactId,
      };
    },
  };

  // ── 2. browser.extract ────────────────────────────────────────────────────
  const extractInputSchema = z.object({
    selector: z
      .string()
      .optional()
      .describe("Sélecteur CSS optionnel pour n'extraire qu'un conteneur spécifique du DOM"),
    format: z
      .enum(["text", "markdown", "html"])
      .default("markdown")
      .describe(
        "Format de sortie : 'markdown' (lisible et structuré), 'text' (brut), ou 'html' (structure brute)",
      ),
    maxCharacters: z
      .number()
      .int()
      .min(100)
      .max(50_000)
      .default(12_000)
      .describe("Nombre maximum de caractères à extraire pour protéger le contexte du modèle"),
    sessionId: z.string().optional().describe("Identifiant de session de navigation"),
  });

  const extractOutputSchema = z.object({
    url: z.string(),
    title: z.string(),
    content: z.string(),
    format: z.enum(["text", "markdown", "html"]),
    truncated: z.boolean(),
  });

  const extractTool: ToolDefinition<
    z.infer<typeof extractInputSchema>,
    z.infer<typeof extractOutputSchema>
  > = {
    name: "browser.extract",
    description:
      "Extrait le contenu lisible (texte ou markdown épuré) de la page active. Supprime automatiquement les scripts, " +
      "styles et champs de mot de passe pour ne renvoyer que l'information utile. Outil de LECTURE SEULE, idempotent.",
    riskLevel: "SAFE",
    requiredPermissions: ["browser.navigate"],
    requiresConfirmation: false,
    inputSchema: extractInputSchema,
    outputSchema: extractOutputSchema,
    summarize: (input) => `Extraction du contenu (${input.format ?? "markdown"})`,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input.sessionId, context);
      await sessionManager.getOrCreateSession(sessionId);
      sessionManager.recordAction(sessionId);

      context.onProgress({ pct: 50, label: "Extraction du contenu de la page" });
      const result = await driver.extract({
        selector: input.selector ?? undefined,
        format: input.format,
        maxChars: input.maxCharacters,
      });

      // Vérifie si le contenu extrait indique un blocage de type CAPTCHA/MFA
      const check = policy.detectHumanIntervention(
        { url: result.url, title: result.title, w: 0, h: 0, sx: 0, sy: 0, pw: 0, ph: 0 },
        result.content,
      );
      if (check.required) {
        sessionManager.suspendForHumanIntervention(sessionId, check.reason!, result.url);
        throw new HumanInterventionRequiredError(check.reason!, result.url);
      }

      context.onProgress({
        pct: 100,
        label: `Extraction terminée (${result.content.length} caractères)`,
      });
      return result;
    },
  };

  // ── 3. browser.click ──────────────────────────────────────────────────────
  const clickInputSchema = z.object({
    target: z
      .union([
        z
          .string()
          .describe("Sélecteur CSS de l'élément à cliquer (ex: 'button.submit', '#confirm')"),
        z
          .object({ x: z.number(), y: z.number() })
          .describe("Coordonnées pixels (x, y) dans le viewport"),
      ])
      .describe("Cible du clic"),
    sessionId: z.string().optional().describe("Identifiant de session de navigation"),
    waitLoad: z
      .boolean()
      .default(true)
      .describe("Attend la fin du chargement éventuel déclenché par le clic"),
  });

  const clickOutputSchema = z.object({
    clicked: z.literal(true),
    target: z.string(),
    newUrl: z.string().optional(),
    title: z.string().optional(),
    screenshotArtifactId: z.string().optional(),
  });

  const clickTool: ToolDefinition<
    z.infer<typeof clickInputSchema>,
    z.infer<typeof clickOutputSchema>
  > = {
    name: "browser.click",
    description:
      "Clique sur un élément de la page via son sélecteur CSS ou ses coordonnées pixel. " +
      "Attend la stabilisation réseau ou le rechargement de page consécutif.",
    riskLevel: "MEDIUM",
    requiredPermissions: ["browser.interact"],
    requiresConfirmation: false,
    inputSchema: clickInputSchema,
    outputSchema: clickOutputSchema,
    summarize: (input) =>
      typeof input.target === "string"
        ? `Clic sur '${input.target}'`
        : `Clic aux coordonnées (${input.target.x}, ${input.target.y})`,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input.sessionId, context);
      await sessionManager.getOrCreateSession(sessionId);
      sessionManager.recordAction(sessionId);

      context.onProgress({ pct: 30, label: "Exécution du clic" });
      const targetParam =
        typeof input.target === "string" ? { selector: input.target } : input.target;
      const res = await driver.click(targetParam);

      // Si l'URL a changé, validation de sécurité sur la nouvelle URL
      if (res.newUrl && res.newUrl !== "about:blank") {
        policy.assertUrlSafe(res.newUrl);
      }

      let screenshotArtifactId: string | undefined;
      try {
        const shot = await driver.screenshot();
        const info = await driver.pageInfo();
        const artifact = await sessionManager.saveScreenshotArtifact(
          sessionId,
          shot.filePath,
          info,
        );
        screenshotArtifactId = artifact.id;
      } catch {
        // Optionnel
      }

      context.onProgress({ pct: 100, label: "Clic effectué" });
      return {
        clicked: true as const,
        target: res.target,
        newUrl: res.newUrl,
        title: res.title,
        screenshotArtifactId,
      };
    },
  };

  // ── 4. browser.type ───────────────────────────────────────────────────────
  const typeInputSchema = z.object({
    target: z
      .string()
      .min(1)
      .describe("Sélecteur CSS du champ de saisie (ex: 'input[name=\"q\"]', '#search')"),
    text: z.string().describe("Texte à saisir dans l'élément"),
    submit: z.boolean().default(false).describe("Appuie sur la touche Entrée après la saisie"),
    clear: z.boolean().default(true).describe("Efface le contenu existant avant de saisir"),
    sessionId: z.string().optional().describe("Identifiant de session de navigation"),
  });

  const typeOutputSchema = z.object({
    typed: z.literal(true),
    target: z.string(),
    length: z.number(),
  });

  const typeTool: ToolDefinition<
    z.infer<typeof typeInputSchema>,
    z.infer<typeof typeOutputSchema>
  > = {
    name: "browser.type",
    description:
      "Saisit du texte dans un champ de formulaire ciblé par son sélecteur CSS. " +
      "Peut optionnellement effacer au préalable et valider avec Entrée.",
    riskLevel: "MEDIUM",
    requiredPermissions: ["browser.interact"],
    requiresConfirmation: false,
    inputSchema: typeInputSchema,
    outputSchema: typeOutputSchema,
    summarize: (input) => `Saisie de ${input.text.length} caractères dans '${input.target}'`,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input.sessionId, context);
      await sessionManager.getOrCreateSession(sessionId);
      sessionManager.recordAction(sessionId);

      context.onProgress({ pct: 40, label: `Saisie de texte dans ${input.target}` });
      const res = await driver.type(input.target, input.text, {
        submit: input.submit,
        clear: input.clear,
      });

      context.onProgress({ pct: 100, label: "Saisie terminée" });
      return res;
    },
  };

  // ── 5. browser.screenshot ─────────────────────────────────────────────────
  const screenshotInputSchema = z.object({
    fullPage: z.boolean().default(false).describe("Capture la page entière (si disponible)"),
    sessionId: z.string().optional().describe("Identifiant de session de navigation"),
  });

  const screenshotOutputSchema = z.object({
    artifactId: z.string(),
    fileName: z.string(),
    filePath: z.string(),
    url: z.string(),
    title: z.string(),
  });

  const screenshotTool: ToolDefinition<
    z.infer<typeof screenshotInputSchema>,
    z.infer<typeof screenshotOutputSchema>
  > = {
    name: "browser.screenshot",
    description:
      "Prend une capture d'écran de l'onglet actif et l'enregistre de manière persistante comme artefact de la mission.",
    riskLevel: "SAFE",
    requiredPermissions: ["browser.navigate"],
    requiresConfirmation: false,
    inputSchema: screenshotInputSchema,
    outputSchema: screenshotOutputSchema,
    summarize: () => "Capture d'écran de la page",
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input.sessionId, context);
      await sessionManager.getOrCreateSession(sessionId);
      sessionManager.recordAction(sessionId);

      context.onProgress({ pct: 30, label: "Capture de la page Chromium" });
      const shot = await driver.screenshot();
      const info = await driver.pageInfo();

      context.onProgress({ pct: 80, label: "Sauvegarde de l'artefact persistant" });
      const artifact = await sessionManager.saveScreenshotArtifact(sessionId, shot.filePath, info);

      context.onProgress({ pct: 100, label: "Capture d'écran disponible" });
      return {
        artifactId: artifact.id,
        fileName: artifact.fileName,
        filePath: artifact.filePath,
        url: artifact.url,
        title: artifact.title,
      };
    },
  };

  return [navigateTool, extractTool, clickTool, typeTool, screenshotTool];
}
