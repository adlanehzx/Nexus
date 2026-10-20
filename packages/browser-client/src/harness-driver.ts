import { spawn } from "node:child_process";
import { URL } from "node:url";

export interface PageInfo {
  url: string;
  title: string;
  w: number;
  h: number;
  sx: number;
  sy: number;
  pw: number;
  ph: number;
}

export interface ExtractionResult {
  url: string;
  title: string;
  content: string;
  format: "text" | "markdown" | "html";
  truncated: boolean;
}

export interface ClickResult {
  clicked: true;
  target: string;
  newUrl?: string | undefined;
  title?: string | undefined;
}

export interface TypeResult {
  typed: true;
  target: string;
  length: number;
}

export interface ScreenshotResult {
  filePath: string;
  format: "png";
  width?: number;
  height?: number;
}

export interface TabSummary {
  targetId: string;
  title: string;
  url: string;
}

export interface HarnessDoctorReport {
  schema_version: number;
  healthy: boolean;
  version: string | null;
  install_mode: string | null;
  chrome_running: boolean | null;
  daemon: {
    name: string;
    alive: boolean;
    browser_ready: boolean;
  };
}

interface ExecPythonResponse {
  success: boolean;
  error?: string;
  info?: PageInfo;
  url?: string;
  title?: string;
  content?: string;
  format?: "text" | "markdown" | "html";
  truncated?: boolean;
  clicked?: boolean;
  target?: string;
  newUrl?: string;
  typed?: boolean;
  length?: number;
  filePath?: string;
  targetId?: string;
  tabs?: TabSummary[];
}

export interface BrowserHarnessDriverOptions {
  cdpUrl?: string;
  commandPath?: string;
  defaultTimeoutMs?: number;
}

export class BrowserHarnessDriverError extends Error {
  readonly code: string;
  constructor(message: string, code = "BROWSER_HARNESS_ERROR") {
    super(message);
    this.name = "BrowserHarnessDriverError";
    this.code = code;
  }
}

/**
 * Pilote natif Chromium via browser-harness (CDP local 127.0.0.1:19222).
 *
 * Aucune boucle LLM secondaire : ce pilote exécute directement les commandes
 * de navigation, d'extraction, de clic et de saisie sur le navigateur local
 * sans recourir à une clé API payante.
 */
export class BrowserHarnessDriver {
  readonly #cdpUrl: string;
  readonly #commandPath: string;
  readonly #defaultTimeoutMs: number;

  constructor(options: BrowserHarnessDriverOptions = {}) {
    const rawCdpUrl = options.cdpUrl ?? process.env.BU_CDP_URL ?? "http://127.0.0.1:19222";
    const parsed = new URL(rawCdpUrl);
    if (
      parsed.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
    ) {
      throw new BrowserHarnessDriverError(
        "Le CDP de Browser Harness doit rester sur la boucle locale (127.0.0.1).",
        "SECURITY_CDP_LOOPBACK_REQUIRED",
      );
    }
    this.#cdpUrl = parsed.toString().replace(/\/$/, "");
    this.#commandPath = options.commandPath ?? process.env.BU_COMMAND_PATH ?? "browser-harness";
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 20_000;
  }

  get cdpUrl(): string {
    return this.#cdpUrl;
  }

  /**
   * Diagnostic de santé du daemon et de Chromium.
   */
  async doctor(): Promise<HarnessDoctorReport> {
    const { stdout } = await this.#runCli(
      ["doctor", "--json", "--require-existing-daemon"],
      "",
      8_000,
    );
    try {
      return JSON.parse(stdout) as HarnessDoctorReport;
    } catch {
      throw new BrowserHarnessDriverError(
        "Rapport doctor browser-harness illisible ou invalide.",
        "INVALID_DOCTOR_REPORT",
      );
    }
  }

  /**
   * Navigue vers une URL et attend la stabilisation du chargement.
   */
  async navigate(url: string, options: { timeoutMs?: number } = {}): Promise<PageInfo> {
    const script = `
import json
try:
    ensure_real_tab()
    goto_url(${JSON.stringify(url)})
    wait_for_load()
    info = page_info()
    print(json.dumps({"success": True, "info": info}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const res = await this.#execPython(script, options.timeoutMs ?? this.#defaultTimeoutMs);
    if (!res.success || !res.info) {
      throw new BrowserHarnessDriverError(
        `Échec de navigation vers ${url}: ${res.error ?? "inconnu"}`,
        "NAVIGATION_FAILED",
      );
    }
    return res.info;
  }

  /**
   * Récupère les métadonnées et dimensions de la page courante.
   */
  async pageInfo(): Promise<PageInfo> {
    const script = `
import json
try:
    ensure_real_tab()
    info = page_info()
    print(json.dumps({"success": True, "info": info}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const res = await this.#execPython(script, 10_000);
    if (!res.success || !res.info) {
      throw new BrowserHarnessDriverError(
        `Impossible de lire page_info: ${res.error ?? "inconnu"}`,
        "PAGE_INFO_FAILED",
      );
    }
    return res.info;
  }

  /**
   * Extrait le contenu lisible (texte, markdown ou html) en filtrant les données sensibles.
   */
  async extract(
    options: {
      selector?: string | undefined;
      format?: "text" | "markdown" | "html" | undefined;
      maxChars?: number | undefined;
    } = {},
  ): Promise<ExtractionResult> {
    const format = options.format ?? "markdown";
    const selector = options.selector ?? null;
    const maxChars = options.maxChars ?? 12_000;

    const cleanJsCode = `(() => {
        const root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.body"};
        if (!root) return { found: false };
        
        // Clone pour assainir sans polluer la vraie page
        const clone = root.cloneNode(true);
        // Supprime les scripts, styles, iframes et champs de mot de passe
        clone.querySelectorAll('script, style, noscript, iframe, input[type="password"]').forEach(el => el.remove());
        
        let content = "";
        const format = ${JSON.stringify(format)};
        if (format === "html") {
            content = clone.outerHTML || clone.innerHTML || "";
        } else if (format === "markdown") {
            // Conversion markdown basique et lisible
            const walk = (node) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    return node.textContent.replace(/\\s+/g, ' ');
                }
                if (node.nodeType !== Node.ELEMENT_NODE) return '';
                const tag = node.tagName.toLowerCase();
                let inner = Array.from(node.childNodes).map(walk).join('');
                if (tag === 'h1') return '\\n# ' + inner.trim() + '\\n';
                if (tag === 'h2') return '\\n## ' + inner.trim() + '\\n';
                if (tag === 'h3') return '\\n### ' + inner.trim() + '\\n';
                if (tag === 'p') return '\\n' + inner.trim() + '\\n';
                if (tag === 'li') return '\\n* ' + inner.trim();
                if (tag === 'a' && node.href) return '[' + inner.trim() + '](' + node.href + ')';
                return inner;
            };
            content = walk(clone).trim();
        } else {
            content = clone.innerText || clone.textContent || "";
        }
        
        return { found: true, content };
    })()`;

    const script = `
import json
try:
    ensure_real_tab()
    info = page_info()
    clean_js = json.loads(${JSON.stringify(JSON.stringify(cleanJsCode))})
    result = js(clean_js)
    if not result or not result.get("found"):
        print(json.dumps({"success": False, "error": "Élément introuvable pour l'extraction"}))
    else:
        raw_content = result.get("content", "")
        truncated = len(raw_content) > ${maxChars}
        content = raw_content[:${maxChars}]
        print(json.dumps({
            "success": True,
            "url": info.get("url", ""),
            "title": info.get("title", ""),
            "content": content,
            "format": ${JSON.stringify(format)},
            "truncated": truncated
        }))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const res = await this.#execPython(script, 15_000);
    if (!res.success) {
      throw new BrowserHarnessDriverError(
        `Échec d'extraction: ${res.error ?? "inconnu"}`,
        "EXTRACTION_FAILED",
      );
    }
    return {
      url: res.url ?? "",
      title: res.title ?? "",
      content: res.content ?? "",
      format: res.format ?? format,
      truncated: res.truncated ?? false,
    };
  }

  /**
   * Clique sur un élément ciblé par sélecteur CSS ou coordonnées (x, y).
   */
  async click(target: { x: number; y: number } | { selector: string }): Promise<ClickResult> {
    let isCoords = false;
    let xCoord = 0;
    let yCoord = 0;
    let selectorStr = "";
    if ("x" in target && "y" in target) {
      isCoords = true;
      xCoord = target.x;
      yCoord = target.y;
    } else {
      selectorStr = target.selector;
    }

    const boxJsCode = selectorStr
      ? `(() => {
        const el = document.querySelector(${JSON.stringify(selectorStr)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { "x": r.left + r.width / 2, "y": r.top + r.height / 2, "visible": r.width > 0 && r.height > 0 };
    })()`
      : "";

    const script = `
import json
try:
    ensure_real_tab()
    target_desc = ""
    if ${isCoords ? "True" : "False"}:
        x = ${xCoord}
        y = ${yCoord}
        target_desc = f"({x}, {y})"
        click_at_xy(x, y)
    else:
        sel = ${JSON.stringify(selectorStr)}
        target_desc = sel
        box_js = json.loads(${JSON.stringify(JSON.stringify(boxJsCode))})
        pos = js(box_js)
        if not pos or not pos.get("visible"):
            print(json.dumps({"success": False, "error": f"Sélecteur '{sel}' introuvable ou invisible"}))
            import sys; sys.exit(0)
        click_at_xy(int(pos["x"]), int(pos["y"]))
    
    # Attend la stabilisation éventuelle
    wait_for_load()
    info = page_info()
    print(json.dumps({
        "success": True,
        "clicked": True,
        "target": target_desc,
        "newUrl": info.get("url"),
        "title": info.get("title")
    }))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const res = await this.#execPython(script, 15_000);
    if (!res.success) {
      throw new BrowserHarnessDriverError(
        `Échec du clic: ${res.error ?? "inconnu"}`,
        "CLICK_FAILED",
      );
    }
    return {
      clicked: true,
      target: res.target ?? "",
      newUrl: res.newUrl,
      title: res.title,
    };
  }

  /**
   * Saisit du texte dans un champ ciblé par son sélecteur.
   */
  async type(
    target: string | { selector: string },
    text: string,
    options: { submit?: boolean; clear?: boolean } = {},
  ): Promise<TypeResult> {
    const selector = typeof target === "string" ? target : target.selector;
    const clearFirst = options.clear ?? true;
    const submit = options.submit ?? false;

    const script = `
import json
try:
    ensure_real_tab()
    sel = ${JSON.stringify(selector)}
    txt = ${JSON.stringify(text)}
    
    fill_input(sel, txt, clear_first=${clearFirst ? "True" : "False"})
    if ${submit ? "True" : "False"}:
        press_key("Enter")
        wait_for_load()
        
    print(json.dumps({
        "success": True,
        "typed": True,
        "target": sel,
        "length": len(txt)
    }))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const res = await this.#execPython(script, 15_000);
    if (!res.success) {
      throw new BrowserHarnessDriverError(
        `Échec de la saisie: ${res.error ?? "inconnu"}`,
        "TYPE_FAILED",
      );
    }
    return {
      typed: true,
      target: res.target ?? selector,
      length: res.length ?? text.length,
    };
  }

  /**
   * Capture une capture d'écran de l'onglet actif.
   */
  async screenshot(): Promise<ScreenshotResult> {
    const script = `
import json
try:
    ensure_real_tab()
    shot_path = capture_screenshot()
    print(json.dumps({
        "success": True,
        "filePath": shot_path,
        "format": "png"
    }))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const res = await this.#execPython(script, 15_000);
    if (!res.success) {
      throw new BrowserHarnessDriverError(
        `Échec de la capture d'écran: ${res.error ?? "inconnu"}`,
        "SCREENSHOT_FAILED",
      );
    }
    return {
      filePath: res.filePath ?? "",
      format: "png",
    };
  }

  /**
   * Crée un nouvel onglet Chromium et retourne son identifiant unique de cible (`targetId`).
   */
  async createTab(url = "about:blank"): Promise<string> {
    const script = `
import json
try:
    tid = new_tab(${JSON.stringify(url)})
    print(json.dumps({"success": True, "targetId": tid}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const res = await this.#execPython(script, 10_000);
    if (!res.success || !res.targetId) {
      throw new BrowserHarnessDriverError(
        `Impossible de créer un onglet: ${res.error ?? "inconnu"}`,
        "TAB_CREATE_FAILED",
      );
    }
    return res.targetId;
  }

  /**
   * Bascule sur un onglet existant par son identifiant de cible.
   */
  async switchTab(targetId: string): Promise<void> {
    const script = `
import json
try:
    switch_tab(${JSON.stringify(targetId)})
    print(json.dumps({"success": True}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const res = await this.#execPython(script, 10_000);
    if (!res.success) {
      throw new BrowserHarnessDriverError(
        `Impossible de basculer sur l'onglet ${targetId}: ${res.error}`,
        "TAB_SWITCH_FAILED",
      );
    }
  }

  /**
   * Ferme un onglet par son identifiant de cible.
   */
  async closeTab(targetId: string): Promise<void> {
    const script = `
import json
try:
    close_tab(${JSON.stringify(targetId)})
    print(json.dumps({"success": True}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const res = await this.#execPython(script, 10_000);
    if (!res.success) {
      throw new BrowserHarnessDriverError(
        `Impossible de fermer l'onglet ${targetId}: ${res.error}`,
        "TAB_CLOSE_FAILED",
      );
    }
  }

  /**
   * Liste tous les onglets ouverts dans Chromium.
   */
  async listTabs(): Promise<TabSummary[]> {
    const script = `
import json
try:
    tabs = list_tabs()
    out = []
    for t in tabs:
        out.append({
            "targetId": t.get("targetId") or t.get("target_id") or "",
            "title": t.get("title") or "",
            "url": t.get("url") or ""
        })
    print(json.dumps({"success": True, "tabs": out}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const res = await this.#execPython(script, 10_000);
    if (!res.success) {
      throw new BrowserHarnessDriverError(
        `Impossible de lister les onglets: ${res.error ?? "inconnu"}`,
        "TAB_LIST_FAILED",
      );
    }
    return res.tabs ?? [];
  }

  /**
   * Exécute un script Python arbitraire via le CLI browser-harness sur l'entrée standard.
   */
  async #execPython(script: string, timeoutMs: number): Promise<ExecPythonResponse> {
    const { stdout } = await this.#runCli([], script, timeoutMs);
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new BrowserHarnessDriverError(
        "Aucune sortie reçue du processus browser-harness.",
        "NO_OUTPUT",
      );
    }
    // Si la sortie contient plusieurs lignes, le JSON final se trouve sur la dernière ligne
    const lines = trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const lastLine = lines[lines.length - 1];
    if (!lastLine) {
      throw new BrowserHarnessDriverError("Sortie vide reçue de browser-harness.", "EMPTY_OUTPUT");
    }
    try {
      return JSON.parse(lastLine) as ExecPythonResponse;
    } catch {
      throw new BrowserHarnessDriverError(
        `Réponse JSON invalide de browser-harness: ${trimmed.slice(0, 300)}`,
        "INVALID_JSON_OUTPUT",
      );
    }
  }

  async #runCli(
    args: string[],
    stdin: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#commandPath, args, {
        env: { ...process.env, BU_CDP_URL: this.#cdpUrl },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(
          new BrowserHarnessDriverError(
            "Délai d'exécution dépassé pour browser-harness.",
            "TIMEOUT",
          ),
        );
      }, timeoutMs);
      timer.unref();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-131_072);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-16_384);
      });

      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.once("close", (code) => {
        clearTimeout(timer);
        const exitCode = code ?? 1;
        if (exitCode !== 0 && args[0] !== "doctor") {
          reject(
            new BrowserHarnessDriverError(
              `Le processus browser-harness s'est terminé avec le code ${exitCode}. ${stderr.slice(0, 300)}`,
              "PROCESS_EXIT_ERROR",
            ),
          );
          return;
        }
        resolve({ stdout, stderr, code: exitCode });
      });

      child.stdin.end(stdin);
    });
  }
}
