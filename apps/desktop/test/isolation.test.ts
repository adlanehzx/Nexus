import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Le cloisonnement entre le client et l'exécutant, vérifié à la source.
 *
 * Le portable est les deux à la fois. C'est justement pour cela qu'il faut
 * l'éprouver : sur cette machine, et sur elle seule, la tentation existe
 * d'écrire un raccourci — « puisque le worker tourne à côté, appelons-le
 * directement ». Ce raccourci ferait de la fenêtre un shell, et rendrait
 * contournable toute la chaîne `cœur → autorisation → capacité → exécution`.
 *
 * Ces tests sont **structurels**. Ils ne vérifient pas qu'un chemin d'exécution
 * se comporte bien : ils vérifient qu'il n'existe pas. Une garantie qui repose
 * sur le fait que personne n'écrira le mauvais appel n'est pas une garantie ;
 * une garantie qui casse le build quand quelqu'un l'écrit en est une.
 */

const racine = fileURLToPath(new URL("..", import.meta.url));

function fichiersSources(dossier: string): string[] {
  const trouves: string[] = [];

  for (const entree of readdirSync(dossier)) {
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) {
      trouves.push(...fichiersSources(chemin));
    } else if (/\.tsx?$/.test(entree)) {
      trouves.push(chemin);
    }
  }

  return trouves;
}

/**
 * Retire commentaires et chaînes.
 *
 * Sans cela, la prose qui explique *pourquoi* `child_process` est proscrit
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

const sources = fichiersSources(join(racine, "src")).map((chemin) => ({
  chemin: chemin.slice(racine.length).replace(/\\/g, "/"),
  code: codeSeul(readFileSync(chemin, "utf8")),
  brut: readFileSync(chemin, "utf8"),
}));

describe("l'interface n'atteint pas l'exécutant", () => {
  it("n'importe aucun module du worker", () => {
    // Importer le cœur worker suffirait : ses capacités seraient alors
    // appelables depuis un gestionnaire de clic.
    const interdits = [
      "@nexus/worker-core",
      "@nexus/windows-worker",
      "@nexus/android-worker",
      "@nexus/devices",
      "@nexus/agent-core",
      "@nexus/tools",
    ];

    const fautifs = sources.filter((fichier) =>
      interdits.some((module) => fichier.code.includes(module)),
    );

    expect(fautifs.map((fichier) => fichier.chemin)).toEqual([]);
  });

  it("n'importe aucun module Node qui touche au système", () => {
    // Le moteur de rendu n'en a pas l'accès de toute façon ; l'interdire à la
    // source évite qu'un jour quelqu'un déplace ce code dans le processus
    // principal en croyant ne rien changer.
    const interdits = [
      "node:child_process",
      "node:fs",
      "node:os",
      "node:process",
      "node:net",
      "child_process",
      "execa",
    ];

    const fautifs = sources.filter((fichier) =>
      interdits.some((module) => new RegExp(`["']${module}["']`).test(fichier.brut)),
    );

    expect(fautifs.map((fichier) => fichier.chemin)).toEqual([]);
  });

  it("ne déclare aucune de ces dépendances", () => {
    const manifeste = JSON.parse(readFileSync(join(racine, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const declarees = Object.keys({
      ...manifeste.dependencies,
      ...manifeste.devDependencies,
    });

    for (const interdit of [
      "@nexus/worker-core",
      "@nexus/windows-worker",
      "@nexus/devices",
      "ws",
    ]) {
      expect(declarees).not.toContain(interdit);
    }
  });
});

describe("la surface de la coquille", () => {
  const port = readFileSync(join(racine, "src/lib/shell.ts"), "utf8");
  const shells = readFileSync(join(racine, "src/lib/shells.ts"), "utf8");

  it("n'expose rien qui ressemble à une exécution", () => {
    // On cherche dans le **code**, pas dans la prose : le port explique
    // longuement ce qu'il refuse, et cette explication doit rester lisible.
    const code = codeSeul(port);

    for (const verbe of [
      "exec",
      "spawn",
      "runCommand",
      "shell(",
      "writeFile",
      "readFile",
      "deleteFile",
      "startProcess",
      "killProcess",
    ]) {
      expect(code).not.toContain(verbe);
    }
  });

  it("n'expose que les commandes natives énumérées", () => {
    // La liste TypeScript et la liste Rust doivent coïncider. Si la coquille
    // native gagnait une commande que le port ne nomme pas, elle serait
    // atteignable par un `invoke` arbitraire sans que rien ici ne le signale.
    //
    // On lit l'union `TauriCommand` sur la source **brute** : c'est là que les
    // noms vivent, et `codeSeul` vide justement les chaînes.
    const union = /type TauriCommand =([^;]+);/.exec(shells);
    expect(union).not.toBeNull();

    const declarees = [...(union?.[1] ?? "").matchAll(/"([a-z_]+)"/g)]
      .map((correspondance) => correspondance[1])
      .filter((nom): nom is string => nom !== undefined);

    const rust = readFileSync(join(racine, "src-tauri/src/main.rs"), "utf8");
    const bloc = /invoke_handler\(tauri::generate_handler!\[([^\]]+)\]\)/.exec(rust);
    expect(bloc).not.toBeNull();

    const exposees = (bloc?.[1] ?? "")
      .split(",")
      .map((nom) => nom.trim())
      .filter((nom) => nom.length > 0);

    expect([...exposees].sort()).toEqual(
      [
        "local_worker_device_id",
        "machine_name",
        "notify",
        "open_external",
        "secret_get",
        "secret_remove",
        "secret_set",
      ].sort(),
    );

    // Toute commande native doit être nommée côté TypeScript : une commande que
    // le port ignore est une porte que personne ne surveille.
    for (const commande of exposees) {
      expect(declarees).toContain(commande);
    }
  });

  it("la coquille native ne sait pas exécuter", () => {
    const rust = readFileSync(join(racine, "src-tauri/src/main.rs"), "utf8")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

    for (const interdit of ["Command::new", "std::process::Command", "shell_execute"]) {
      expect(rust).not.toContain(interdit);
    }
  });
});
