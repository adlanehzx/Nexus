import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ce que le tableau de bord ne demande pas.
 *
 * La vraie garantie de non-divulgation du raisonnement est **côté serveur** : la
 * projection ne lit jamais le transcript, et le schéma Zod de la réponse ne
 * contient pas de champ pour le porter. Un client ne peut pas afficher ce qu'on
 * ne lui envoie pas.
 *
 * Ces tests sont la seconde barrière. Ils ne remplacent pas la première ; ils
 * empêchent qu'on la contourne un jour depuis ce côté-ci — en ajoutant une route
 * « pour déboguer », en lisant un champ qui n'aurait pas dû exister, en tapant
 * dans une API voisine. Ce sont des vérifications **structurelles** : elles ne
 * décrivent pas un comportement, elles constatent une absence.
 */

const racine = fileURLToPath(new URL("..", import.meta.url));

function fichiers(dossier: string): string[] {
  const trouves: string[] = [];

  for (const entree of readdirSync(dossier)) {
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) trouves.push(...fichiers(chemin));
    else if (/\.tsx?$/.test(entree)) trouves.push(chemin);
  }

  return trouves;
}

/**
 * Retire commentaires et chaînes.
 *
 * Sans cela, la prose qui explique *pourquoi* `providerBlocks` est proscrit
 * ferait échouer le test qui l'interdit — et on finirait par supprimer
 * l'explication pour faire passer la vérification.
 */
function codeSeul(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

const sources = fichiers(join(racine, "src")).map((chemin) => ({
  chemin: chemin.slice(racine.length).replace(/\\/g, "/"),
  code: codeSeul(readFileSync(chemin, "utf8")),
  brut: readFileSync(chemin, "utf8"),
}));

describe("le raisonnement n'est jamais demandé", () => {
  it("aucun champ de transcript n'est lu", () => {
    const interdits = ["providerBlocks", "callSignatures", "pendingConfirmation", "thinking"];

    const fautifs = sources.filter((fichier) =>
      interdits.some((champ) => fichier.code.includes(champ)),
    );

    expect(fautifs.map((fichier) => fichier.chemin)).toEqual([]);
  });

  it("le type d'un run ne déclare aucun champ interdit", () => {
    const api = readFileSync(join(racine, "src/lib/api.ts"), "utf8");
    const bloc = /export interface AgentRunRow \{([\s\S]*?)\n\}/.exec(api);

    expect(bloc).not.toBeNull();

    // Le contrat, lu depuis le code : ce qui n'est pas ici ne s'affiche pas.
    for (const champ of ["messages", "transcript", "providerBlocks", "content"]) {
      expect(bloc?.[1] ?? "").not.toContain(champ);
    }
  });
});

describe("la supervision reste en lecture seule", () => {
  it("la seule écriture est l'envoi explicite d'une mission au chat", () => {
    // Superviser et administrer sont deux surfaces. Les réunir mettrait une
    // action destructrice à un clic d'un écran qu'on consulte machinalement.
    const source = readFileSync(join(racine, "src/lib/api.ts"), "utf8");
    const client = codeSeul(source);

    for (const verbe of ["PATCH", "DELETE", "PUT"]) {
      expect(client).not.toContain(verbe);
    }
    expect(source.match(/this\.#request\("POST"/g)).toHaveLength(2);
  });

  it("n'appelle que la supervision et la façade orchestrateur", () => {
    // Une route voisine ouverte « pour déboguer » n'aurait pas la même garde ni
    // la même projection.
    const api = readFileSync(join(racine, "src/lib/api.ts"), "utf8");
    const chemins = [...api.matchAll(/"(\/api\/v1\/[^"`]*)"/g)].map((match) => match[1] ?? "");
    const gabarits = [...api.matchAll(/`(\/api\/v1\/[^`]*)`/g)].map((match) => match[1] ?? "");

    for (const chemin of [...chemins, ...gabarits]) {
      expect(chemin, chemin).toMatch(/^\/api\/v1\/(dashboard|orchestrator)\//);
    }
  });

  it("la session est la seule exception, et elle passe par le cœur client", () => {
    // `SessionManager` porte la connexion et le rafraîchissement : un second
    // mécanisme serait un second endroit où se tromper sur l'expiration.
    const client = readFileSync(join(racine, "src/lib/api.ts"), "utf8");

    expect(client).toContain("SessionManager");
    expect(client).not.toContain("/api/v1/auth/login");
  });
});

describe("aucun secret embarqué", () => {
  it("le paquet ne contient pas de jeton en dur", () => {
    for (const fichier of sources) {
      expect(
        /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}/i.test(fichier.code),
        fichier.chemin,
      ).toBe(false);
    }
  });

  it("les jetons ne sont pas écrits dans le stockage du navigateur", () => {
    // Un tableau de bord d'administration est précisément l'endroit où l'on ne
    // veut pas d'un jeton de longue durée lisible par n'importe quel script.
    for (const fichier of sources) {
      expect(fichier.code, fichier.chemin).not.toContain("localStorage");
      expect(fichier.code, fichier.chemin).not.toContain("sessionStorage");
    }
  });
});
