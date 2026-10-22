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
    url: z.string().min(1).describe("Full HTTP or HTTPS URL to navigate to"),
    sessionId: z
      .string()
      .optional()
      .describe("Browser session identifier (defaults to current run identifier)"),
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
      "Navigates to a secure web URL (http or https). Opens or reuses the dedicated session tab, " +
      "waits for load completion and captures a timestamped screenshot. Never navigates to file:, chrome:, " +
      "or private loopback/SSRF-protected IP addresses.",
    riskLevel: "SAFE",
    requiredPermissions: ["browser.navigate"],
    requiresConfirmation: false,
    inputSchema: navigateInputSchema,
    outputSchema: navigateOutputSchema,
    summarize: (input) => `Navigate to ${input.url}`,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input.sessionId, context);
      policy.assertUrlSafe(input.url);

      context.onProgress({ pct: 10, label: `Opening session for ${input.url}` });
      await sessionManager.getOrCreateSession(sessionId);
      sessionManager.recordAction(sessionId);

      context.onProgress({ pct: 40, label: `Loading ${input.url}` });
      const info = await driver.navigate(input.url);

      const check = policy.detectHumanIntervention(info);
      if (check.required) {
        sessionManager.suspendForHumanIntervention(sessionId, check.reason!, info.url);
        throw new HumanInterventionRequiredError(check.reason!, info.url);
      }

      let screenshotArtifactId: string | undefined;
      if (captureScreenshotsOnNavigate) {
        try {
          context.onProgress({ pct: 80, label: "Capturing confirmation screenshot" });
          const shot = await driver.screenshot();
          const artifact = await sessionManager.saveScreenshotArtifact(
            sessionId,
            shot.filePath,
            info,
          );
          screenshotArtifactId = artifact.id;
        } catch {
          // Screenshot capture failure is non-blocking
        }
      }

      context.onProgress({ pct: 100, label: `Page loaded: ${info.title}` });
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
      .describe("Optional CSS selector to extract only a specific DOM container"),
    format: z
      .enum(["text", "markdown", "html"])
      .default("markdown")
      .describe("Output format: 'markdown', 'text', or 'html'"),
    maxCharacters: z
      .number()
      .int()
      .min(100)
      .max(50_000)
      .default(12_000)
      .describe("Maximum character count to extract"),
    sessionId: z.string().optional().describe("Browser session identifier"),
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
      "Extracts readable content (text or sanitized markdown) from active page. Strips scripts, " +
      "styles, and password fields. READ-ONLY and idempotent.",
    riskLevel: "SAFE",
    requiredPermissions: ["browser.navigate"],
    requiresConfirmation: false,
    inputSchema: extractInputSchema,
    outputSchema: extractOutputSchema,
    summarize: (input) => `Extract content (${input.format ?? "markdown"})`,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input.sessionId, context);
      await sessionManager.getOrCreateSession(sessionId);
      sessionManager.recordAction(sessionId);

      context.onProgress({ pct: 50, label: "Extracting page content" });
      const result = await driver.extract({
        selector: input.selector ?? undefined,
        format: input.format,
        maxChars: input.maxCharacters,
      });

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
        label: `Extraction completed (${result.content.length} characters)`,
      });
      return result;
    },
  };

  // ── 3. browser.click ──────────────────────────────────────────────────────
  const clickInputSchema = z.object({
    target: z
      .union([
        z.string().describe("CSS selector of target element (e.g. 'button.submit', '#confirm')"),
        z
          .object({ x: z.number(), y: z.number() })
          .describe("Pixel coordinates (x, y) within viewport"),
      ])
      .describe("Click target"),
    sessionId: z.string().optional().describe("Browser session identifier"),
    waitLoad: z.boolean().default(true).describe("Wait for page load triggered by click"),
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
      "Clicks an element on the page via CSS selector or pixel coordinates. " +
      "Waits for network stabilization or subsequent page load.",
    riskLevel: "MEDIUM",
    requiredPermissions: ["browser.interact"],
    requiresConfirmation: false,
    inputSchema: clickInputSchema,
    outputSchema: clickOutputSchema,
    summarize: (input) =>
      typeof input.target === "string"
        ? `Click on '${input.target}'`
        : `Click at coordinates (${input.target.x}, ${input.target.y})`,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input.sessionId, context);
      await sessionManager.getOrCreateSession(sessionId);
      sessionManager.recordAction(sessionId);

      context.onProgress({ pct: 30, label: "Executing click" });
      const targetParam =
        typeof input.target === "string" ? { selector: input.target } : input.target;
      const res = await driver.click(targetParam);

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
        // Optional
      }

      context.onProgress({ pct: 100, label: "Click executed" });
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
      .describe("CSS selector of input field (e.g. 'input[name=\"q\"]', '#search')"),
    text: z.string().describe("Text to type into element"),
    submit: z.boolean().default(false).describe("Press Enter after typing"),
    clear: z.boolean().default(true).describe("Clear existing text before typing"),
    sessionId: z.string().optional().describe("Browser session identifier"),
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
      "Types text into a form input targeted by CSS selector. " +
      "Can clear input first and submit with Enter.",
    riskLevel: "MEDIUM",
    requiredPermissions: ["browser.interact"],
    requiresConfirmation: false,
    inputSchema: typeInputSchema,
    outputSchema: typeOutputSchema,
    summarize: (input) => `Type ${input.text.length} characters into '${input.target}'`,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input.sessionId, context);
      await sessionManager.getOrCreateSession(sessionId);
      sessionManager.recordAction(sessionId);

      context.onProgress({ pct: 40, label: `Typing text into ${input.target}` });
      const res = await driver.type(input.target, input.text, {
        submit: input.submit,
        clear: input.clear,
      });

      context.onProgress({ pct: 100, label: "Typing completed" });
      return res;
    },
  };

  // ── 5. browser.screenshot ─────────────────────────────────────────────────
  const screenshotInputSchema = z.object({
    fullPage: z.boolean().default(false).describe("Capture entire scrollable page"),
    sessionId: z.string().optional().describe("Browser session identifier"),
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
    description: "Captures a screenshot of the active tab and persists it as a mission artifact.",
    riskLevel: "SAFE",
    requiredPermissions: ["browser.navigate"],
    requiresConfirmation: false,
    inputSchema: screenshotInputSchema,
    outputSchema: screenshotOutputSchema,
    summarize: () => "Page screenshot",
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input.sessionId, context);
      await sessionManager.getOrCreateSession(sessionId);
      sessionManager.recordAction(sessionId);

      context.onProgress({ pct: 30, label: "Capturing Chromium page" });
      const shot = await driver.screenshot();
      const info = await driver.pageInfo();

      context.onProgress({ pct: 80, label: "Saving persistent artifact" });
      const artifact = await sessionManager.saveScreenshotArtifact(sessionId, shot.filePath, info);

      context.onProgress({ pct: 100, label: "Screenshot available" });
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
