import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * La politique de sécurité du contenu, et ce qu'elle autorise selon le mode.
 *
 * Elle a réellement bloqué le client pendant la validation physique : la CSP
 * n'autorise que `https:` et `wss:`, si bien qu'un cœur local en `http://` était
 * injoignable et que l'écran n'affichait qu'un « Failed to fetch ».
 *
 * La réponse n'est pas d'ouvrir `http:` partout — le jeton de session ne doit
 * jamais partir en clair — mais de n'ouvrir **que la boucle locale**, et **que
 * hors production**. Ces tests fixent les deux moitiés de cette règle.
 */

const RACINE = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

function html(): string {
  return readFileSync(path.join(RACINE, "index.html"), "utf8");
}

function connectSrc(source: string): string {
  const trouve = /connect-src ([^"]*)"/.exec(source);
  if (trouve === null) throw new Error("aucune directive connect-src");
  return trouve[1]!;
}

describe("CSP du paquet livré", () => {
  it("n'autorise que https et wss pour joindre le cœur", () => {
    const directive = connectSrc(html());

    expect(directive).toContain("https:");
    expect(directive).toContain("wss:");
    // Le point de sécurité : rien en clair dans le fichier source.
    expect(directive).not.toContain("http://localhost");
    expect(directive).not.toContain("ws://");
  });

  it("laisse Tauri parler à son propre backend", () => {
    // Ce n'est pas une ouverture réseau : `ipc:` et `http://ipc.localhost` sont
    // le canal par lequel la fenêtre appelle le Rust — le second sous Windows,
    // le premier ailleurs.
    //
    // Le défaut réel : `tauri.conf.json` les déclarait, cette balise non, et le
    // navigateur applique l'intersection des deux politiques. Le premier
    // `invoke` — la lecture du trousseau — était refusé, et la connexion
    // échouait sur « Connexion impossible. » sans que rien ne désigne la CSP.
    const directive = connectSrc(html());

    expect(directive).toContain("ipc:");
    expect(directive).toContain("http://ipc.localhost");
  });

  it("interdit toute ressource distante ailleurs que pour la connexion", () => {
    const source = html();

    expect(source).toContain("default-src 'self'");
    expect(source).not.toContain("script-src 'unsafe-eval'");
    expect(source).not.toContain("default-src *");
  });
});

describe("assouplissement de développement", () => {
  /**
   * Rejoue la transformation du greffon Vite sans lancer de build.
   *
   * Le greffon lui-même est exercé par le build réel ; ce test fixe la règle
   * qu'il applique, pour qu'un futur changement de mode ne fasse pas fuiter
   * `http:` dans le paquet livré.
   */
  function transformer(source: string, mode: string): string {
    const LOCAL = [
      "http://localhost:*",
      "http://127.0.0.1:*",
      "ws://localhost:*",
      "ws://127.0.0.1:*",
    ].join(" ");

    if (mode === "production") return source;
    return source.replace(
      /connect-src ([^"]*)"/,
      (_m, valeur: string) => `connect-src ${valeur.trim()} ${LOCAL}"`,
    );
  }

  it("ajoute la boucle locale hors production", () => {
    const directive = connectSrc(transformer(html(), "development"));

    expect(directive).toContain("http://localhost:*");
    expect(directive).toContain("ws://127.0.0.1:*");
    // Ce qui était permis le reste.
    expect(directive).toContain("https:");
  });

  it("n'ouvre PAS http: en général, même en développement", () => {
    // « http://localhost:* » est une exception nommée ; « http: » serait un
    // blanc-seing qui autoriserait n'importe quel site en clair.
    const directive = connectSrc(transformer(html(), "development"));

    expect(directive.split(/\s+/)).not.toContain("http:");
    expect(directive.split(/\s+/)).not.toContain("ws:");
    expect(directive.split(/\s+/)).not.toContain("*");
  });

  it("ne touche à rien en production", () => {
    expect(transformer(html(), "production")).toBe(html());
  });
});

/**
 * La configuration de la coquille native.
 *
 * Tauri injecte sa propre CSP en plus de la balise `<meta>` d'`index.html` ; le
 * moteur de rendu applique l'intersection des deux. Assouplir l'une sans l'autre
 * ne débloque donc rien — c'est ce qui rend ces deux fichiers indissociables.
 */
describe("configuration Tauri", () => {
  const conf = JSON.parse(
    readFileSync(path.join(RACINE, "src-tauri", "tauri.conf.json"), "utf8"),
  ) as {
    version: string;
    app: { withGlobalTauri?: boolean; security: { csp: string; devCsp?: string } };
  };

  it("expose __TAURI__ au moteur de rendu", () => {
    // `src/lib/shells.ts` lit `globalThis.__TAURI__`. Sans ce drapeau, le pont
    // est absent, `detectShell()` retombe sur `WebShell`, et l'application
    // empaquetée perd en silence le trousseau Windows et les notifications.
    expect(conf.app.withGlobalTauri).toBe(true);
  });

  it("garde une CSP de production sans texte clair", () => {
    const csp = conf.app.security.csp;

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("wss:");
    expect(csp).not.toContain("http://localhost");
    expect(csp).not.toContain("ws://");
    // `http://ipc.localhost` est le transport interne de Tauri, pas du réseau.
    expect(csp).toContain("ipc:");
  });

  it("n'ouvre la boucle locale que via devCsp", () => {
    const dev = conf.app.security.devCsp;
    expect(dev).toBeDefined();

    expect(dev).toContain("http://localhost:*");
    expect(dev).toContain("ws://127.0.0.1:*");
    // Une exception nommée, pas un blanc-seing.
    expect(dev?.split(/\s+/)).not.toContain("http:");
    expect(dev?.split(/\s+/)).not.toContain("*");
  });

  it("porte la même version que le paquet et la caisse Rust", () => {
    const pkg = JSON.parse(readFileSync(path.join(RACINE, "package.json"), "utf8")) as {
      version: string;
    };
    const cargo = readFileSync(path.join(RACINE, "src-tauri", "Cargo.toml"), "utf8");
    const versionCargo = /^version = "([^"]+)"/m.exec(cargo)?.[1];

    expect(conf.version).toBe(pkg.version);
    expect(versionCargo).toBe(pkg.version);
  });

  it("déclare l'outil qui construit la coquille", () => {
    // Le script `pnpm tauri` existait sans que `@tauri-apps/cli` soit installé :
    // la commande échouait sur « command not found ».
    const pkg = JSON.parse(readFileSync(path.join(RACINE, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(pkg.scripts.tauri).toBeDefined();
    expect(pkg.devDependencies["@tauri-apps/cli"]).toMatch(/^2\./);
  });
});
