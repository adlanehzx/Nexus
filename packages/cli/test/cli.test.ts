import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  findRepositoryRoot,
  hasPersistentSigningKey,
  readEnvFile,
  resolvePaths,
  upsertEnvValue,
} from "../src/environment.js";
import { exitCodeFor, fail, ok, renderReport, skip, tally, warn } from "../src/report.js";
import { foreignPaths, renderMissionEngineUnit } from "../src/systemd.js";
import { applyPlan, planSetup } from "../src/setup.js";
import { runDoctor } from "../src/doctor.js";
import { hostAndPort, parseUnitShow, type Probes } from "../src/probes.js";

/**
 * Tests de la CLI d'installation.
 *
 * Ce qui est éprouvé ici est tout ce qui doit être vrai **sans machine** : la
 * lecture d'un `.env`, le rendu d'une unité, la détection d'un chemin étranger,
 * le plan d'installation et sa relance. Les sondes réseau et `systemctl` sont
 * remplacées, parce qu'un test qui dépend d'un PostgreSQL vivant ne dit plus
 * rien de la logique qu'il prétend vérifier.
 *
 * Le soin porte surtout sur deux propriétés que l'outil promet : relancer
 * `setup` ne change rien quand tout va bien, et il ne détruit jamais une clé.
 */

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  return root;
}

const PAIR = generateKeyPairSync("ed25519");
const PRIVATE_PEM = PAIR.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_PEM = PAIR.publicKey.export({ type: "spki", format: "pem" }).toString();

describe("localisation de l'installation", () => {
  it("remonte jusqu'à la racine de l'espace de travail", () => {
    const root = workspace();
    const nested = join(root, "services", "api", "src");
    mkdirSync(nested, { recursive: true });

    expect(findRepositoryRoot(nested)).toBe(root);
  });

  it("échoue clairement quand il n'y a pas d'installation", () => {
    const orphan = mkdtempSync(join(tmpdir(), "nexus-orphan-"));
    expect(() => findRepositoryRoot(orphan)).toThrow(/pnpm-workspace/);
  });

  it("dérive tous les chemins de la racine, sans rien coder en dur", () => {
    const paths = resolvePaths("/opt/nexus", "/home/someone");

    expect(paths.missionEngine).toBe("/opt/nexus/services/mission-engine");
    expect(paths.agentRunner).toBe("/opt/nexus/services/agent/dist/cli.js");
    // Hors du dépôt : une clé n'a rien à faire dans un arbre versionné.
    expect(paths.publicKeyFile).toBe("/home/someone/.config/nexus/api-public.pem");
  });
});

describe("lecture et écriture de .env", () => {
  it("lit les valeurs, ignore commentaires et lignes vides", () => {
    const root = workspace();
    writeFileSync(
      join(root, ".env"),
      ["# commentaire", "", "NODE_ENV=development", "API_PORT=3000", "#DISABLED=1"].join("\n"),
    );

    expect(readEnvFile(join(root, ".env"))).toEqual({
      NODE_ENV: "development",
      API_PORT: "3000",
    });
  });

  it("restaure les sauts de ligne échappés d'une valeur entre guillemets", () => {
    const root = workspace();
    // La clé vient de `generateKeyPairSync`, jamais d'un littéral : un en-tête
    // PEM écrit en dur dans une source est signalé par le scanner de secrets,
    // et il a raison de ne pas savoir distinguer un exemple d'une vraie clé.
    writeFileSync(join(root, ".env"), `AUTH_SIGNING_KEY="${PRIVATE_PEM.replace(/\n/g, "\\n")}"\n`);

    // Sans cette restitution, la clé relue serait sur une seule ligne et
    // illisible par `createPrivateKey`.
    const reread = readEnvFile(join(root, ".env")).AUTH_SIGNING_KEY ?? "";
    expect(reread).toContain("\n");
    expect(() => createPrivateKey(reread)).not.toThrow();
  });

  it("rend un objet vide quand le fichier n'existe pas, sans lever", () => {
    expect(readEnvFile(join(workspace(), "absent"))).toEqual({});
  });

  it("remplace une valeur existante sans toucher au reste", () => {
    const before = "NODE_ENV=development\nAPI_PORT=3000\n";
    const after = upsertEnvValue(before, "API_PORT", "4000");

    expect(after).toBe("NODE_ENV=development\nAPI_PORT=4000\n");
  });

  it("réveille une ligne commentée plutôt que d'en ajouter une seconde", () => {
    // C'est là que la documentation attend la valeur : en ajouter une à la fin
    // laisserait le commentaire donner l'impression qu'elle n'est pas définie.
    const after = upsertEnvValue("# AUTH_SIGNING_KEY=\n", "AUTH_SIGNING_KEY", "abc");

    expect(after).toBe("AUTH_SIGNING_KEY=abc\n");
    expect(after).not.toContain("#");
  });

  it("protège par des guillemets une valeur multiligne", () => {
    const after = upsertEnvValue("", "AUTH_SIGNING_KEY", PRIVATE_PEM);

    expect(after).toContain('"');
    // Une seule ligne, donc : les sauts de ligne de la clé sont échappés, sans
    // quoi le fichier serait illisible par un chargeur de `.env`.
    expect(after.split("\n")).toHaveLength(2);
  });

  it("distingue une clé persistante d'une clé absente", () => {
    expect(hasPersistentSigningKey({ AUTH_SIGNING_KEY: PRIVATE_PEM })).toBe(true);
    expect(hasPersistentSigningKey({})).toBe(false);
    expect(hasPersistentSigningKey({ AUTH_SIGNING_KEY: "pas-une-clé" })).toBe(false);
  });
});

describe("rapport", () => {
  const groups = [
    {
      title: "Groupe",
      results: [ok("a", "va bien"), warn("b", "à surveiller", "le geste"), skip("c", "sans objet")],
    },
  ];

  it("compte par état", () => {
    expect(tally(groups)).toEqual({ ok: 1, warn: 1, fail: 0, skip: 1 });
  });

  it("n'échoue que sur un échec, jamais sur un avertissement", () => {
    // Si un avertissement faisait échouer, la distinction disparaîtrait à
    // l'usage : tout deviendrait soit bloquant, soit silencieux.
    expect(exitCodeFor(groups)).toBe(0);
    expect(exitCodeFor([{ title: "x", results: [fail("d", "cassé")] }])).toBe(1);
  });

  it("affiche le geste correctif sur sa propre ligne", () => {
    const rendered = renderReport(groups);

    expect(rendered).toContain("→ le geste");
    expect(rendered).toContain("1 ok · 1 à surveiller · 0 en échec · 1 non applicable");
  });
});

describe("unité systemd", () => {
  const paths = resolvePaths("/opt/nexus", "/home/someone");
  const base = {
    paths,
    pnpmPath: "/usr/bin/pnpm",
    servicePath: "/usr/bin",
    apiUrl: "http://127.0.0.1:3000",
  };

  it("n'écrit aucun chemin hors de l'installation", () => {
    const unit = renderMissionEngineUnit(base);

    // Le défaut que cette CLI existe pour supprimer : l'unité versionnée
    // portait une dizaine de chemins absolus propres à une machine.
    expect(unit).not.toContain("/home/alice/ancien-nexus");
    expect(unit).toContain("WorkingDirectory=/opt/nexus/services/mission-engine");
    expect(unit).toContain("ExecStartPre=/usr/bin/pnpm --dir /opt/nexus");
  });

  it("n'active l'authentification entrante que si une clé est déployée", () => {
    expect(renderMissionEngineUnit(base)).toContain("INACTIVE");
    expect(renderMissionEngineUnit(base)).not.toContain("NEXUS_ENGINE_API_PUBLIC_KEY_FILE=");

    const secured = renderMissionEngineUnit({ ...base, publicKeyFile: "/key.pem" });
    expect(secured).toContain("Environment=NEXUS_ENGINE_API_PUBLIC_KEY_FILE=/key.pem");
  });

  it("repère les chemins d'une installation déplacée", () => {
    const stale = renderMissionEngineUnit({
      ...base,
      paths: resolvePaths("/ancien/emplacement/nexus", "/home/someone"),
    });

    const strays = foreignPaths(stale, "/opt/nexus");
    expect(strays.length).toBeGreaterThan(0);
    expect(strays.some((path) => path.startsWith("/ancien/emplacement"))).toBe(true);
  });

  it("ne signale pas les chemins système légitimes", () => {
    expect(foreignPaths(renderMissionEngineUnit(base), "/opt/nexus")).toEqual([]);
  });
});

describe("plan d'installation", () => {
  function setupIn(root: string, options: Partial<Parameters<typeof planSetup>[0]> = {}) {
    return planSetup({
      paths: resolvePaths(root, join(root, "home")),
      dryRun: false,
      rotateKeys: false,
      pnpmPath: "/usr/bin/pnpm",
      servicePath: "/usr/bin",
      ...options,
    });
  }

  it("génère une clé quand il n'y en a pas, et la relance ne la touche plus", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n");

    applyPlan(setupIn(root));
    const first = readEnvFile(join(root, ".env")).AUTH_SIGNING_KEY;
    expect(first).toContain("BEGIN PRIVATE KEY");

    // L'idempotence est la propriété qui rend la commande utilisable : on la
    // relance après chaque modification, et elle ne doit rien casser.
    const second = setupIn(root);
    applyPlan(second);
    expect(readEnvFile(join(root, ".env")).AUTH_SIGNING_KEY).toBe(first);
    expect(second.actions.filter((action) => action.needed)).toHaveLength(0);
  });

  it("ne remplace une clé que sur demande explicite, et le dit", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n");
    applyPlan(setupIn(root));
    const before = readEnvFile(join(root, ".env")).AUTH_SIGNING_KEY;

    const rotation = setupIn(root, { rotateKeys: true });
    // L'avertissement compte autant que l'action : remplacer la clé invalide
    // les sessions et désaccorde toute clé publique déjà déployée.
    expect(rotation.warnings.join(" ")).toMatch(/sessions/);
    applyPlan(rotation);
    expect(readEnvFile(join(root, ".env")).AUTH_SIGNING_KEY).not.toBe(before);
  });

  it("restreint le fichier de secrets à son propriétaire", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n", { mode: 0o644 });

    applyPlan(setupIn(root));
    expect((statSync(join(root, ".env")).mode & 0o777).toString(8)).toBe("600");
  });

  it("dépose une clé publique qui correspond à la clé privée", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), `AUTH_SIGNING_KEY="${PRIVATE_PEM.replace(/\n/g, "\\n")}"\n`);

    const paths = resolvePaths(root, join(root, "home"));
    applyPlan(setupIn(root));

    expect(readFileSync(paths.publicKeyFile, "utf8").replace(/\s/g, "")).toBe(
      PUBLIC_PEM.replace(/\s/g, ""),
    );
  });

  it("écrit l'unité avec les chemins de cette installation", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n");
    const paths = resolvePaths(root, join(root, "home"));

    applyPlan(setupIn(root));
    const unit = readFileSync(join(paths.systemdUserDir, "nexus-mission-engine.service"), "utf8");

    expect(unit).toContain(root);
    expect(foreignPaths(unit, root)).toEqual([]);
  });

  it("crée .env depuis l'exemple quand il manque", () => {
    const root = workspace();
    writeFileSync(join(root, ".env.example"), "NODE_ENV=development\n");

    const plan = setupIn(root);
    expect(plan.actions[0]?.label).toContain("créer .env");
    applyPlan(plan);
    expect(readEnvFile(join(root, ".env")).NODE_ENV).toBe("development");
  });

  it("génère une URL PostgreSQL avec un mot de passe aléatoire, et prévient", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n");

    const plan = setupIn(root);
    applyPlan(plan);

    const url = readEnvFile(join(root, ".env")).DATABASE_URL ?? "";
    expect(url).toMatch(/^postgresql:\/\/nexus:.+@127\.0\.0\.1:15432\/nexus$/);
    // Le mot de passe ne sert à rien si la base ne l'adopte pas : le dire est
    // la moitié du travail.
    expect(plan.warnings.join(" ")).toMatch(/docker compose/);
  });
});

describe("sondes", () => {
  it("applique le port par défaut du schéma", () => {
    expect(hostAndPort("postgresql://u:p@localhost/db")).toEqual({ host: "localhost", port: 5432 });
    expect(hostAndPort("redis://127.0.0.1")).toEqual({ host: "127.0.0.1", port: 6379 });
    expect(hostAndPort("https://example.test")).toEqual({ host: "example.test", port: 443 });
    expect(hostAndPort("http://127.0.0.1:18100")).toEqual({ host: "127.0.0.1", port: 18100 });
  });

  it("rend undefined sur une URL illisible plutôt que de lever", () => {
    expect(hostAndPort("pas une url")).toBeUndefined();
  });
});

describe("diagnostic", () => {
  /** Sondes remplacées : tout est joignable, rien n'est installé. */
  function probesFor(overrides: Partial<Probes> = {}): Probes {
    return {
      tcp: () => Promise.resolve(true),
      http: () => Promise.resolve({ status: 200, body: '{"profiles":["codex"]}' }),
      command: () => Promise.resolve(undefined),
      ...overrides,
    };
  }

  it("échoue quand .env est absent, et dit quoi faire", async () => {
    const root = workspace();
    const groups = await runDoctor({
      paths: resolvePaths(root, join(root, "home")),
      probes: probesFor(),
      env: {},
    });

    const envCheck = groups[0]?.results[0];
    expect(envCheck?.status).toBe("fail");
    expect(envCheck?.fix).toContain("nexus setup");
  });

  it("signale une clé éphémère comme à surveiller, pas comme une panne", async () => {
    const root = workspace();
    const groups = await runDoctor({
      paths: resolvePaths(root, join(root, "home")),
      probes: probesFor(),
      env: { NODE_ENV: "development" },
    });

    const security = groups.find((group) => group.title === "Sécurité");
    const key = security?.results.find((result) => result.name === "clé de signature");
    // Une installation personnelle sans clé persistante fonctionne : la
    // classer en échec rendrait le diagnostic rouge en permanence.
    expect(key?.status).toBe("warn");
    expect(key?.fix).toContain("nexus setup");
  });

  it("détecte une clé publique déployée qui ne correspond plus", async () => {
    const root = workspace();
    const paths = resolvePaths(root, join(root, "home"));
    mkdirSync(join(root, "home", ".config", "nexus"), { recursive: true });
    const other = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    });
    writeFileSync(paths.publicKeyFile, other);

    const groups = await runDoctor({
      paths,
      probes: probesFor(),
      env: { NODE_ENV: "development", AUTH_SIGNING_KEY: PRIVATE_PEM },
    });

    const security = groups.find((group) => group.title === "Sécurité");
    const deployed = security?.results.find((result) => result.name === "clé publique déployée");
    // Le cas sournois : tous les appels entrants échouent sur une erreur de
    // signature, sans que rien ne nomme le désaccord lui-même.
    expect(deployed?.status).toBe("fail");
  });

  it("signale une base en retard de migration comme un échec", async () => {
    const root = workspace();
    const groups = await runDoctor({
      paths: resolvePaths(root, join(root, "home")),
      probes: probesFor({
        command: (file, args) =>
          Promise.resolve(
            file === "pnpm" && args.includes("status")
              ? "2 migrations found. Following migrations have not yet been applied"
              : undefined,
          ),
      }),
      env: { NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@127.0.0.1:15432/nexus" },
    });

    const data = groups.find((group) => group.title === "Données et services");
    const migrations = data?.results.find((result) => result.name === "migrations PostgreSQL");
    expect(migrations?.status).toBe("fail");
    expect(migrations?.fix).toContain("migrate deploy");
  });

  it("signale une unité systemd absente sans faire échouer le diagnostic", async () => {
    const root = workspace();
    const groups = await runDoctor({
      paths: resolvePaths(root, join(root, "home")),
      probes: probesFor(),
      env: { NODE_ENV: "development" },
    });

    const systemd = groups.find((group) => group.title === "Services systemd");
    expect(systemd?.results.every((result) => result.status !== "fail")).toBe(true);
  });
});

describe("état d'une unité systemd", () => {
  it("lit les propriétés par nom, et non par position", () => {
    // La sortie réelle de `systemctl show` : l'ordre n'est pas celui des `-p`
    // demandés. Une lecture positionnelle prenait ici `ActiveState` pour
    // `UnitFileState`, et rapportait une unité active comme arrêtée.
    const output = [
      "LoadState=loaded",
      "ActiveState=active",
      "FragmentPath=/home/someone/.config/systemd/user/nexus-mission-engine.service",
      "UnitFileState=enabled",
    ].join("\n");

    expect(parseUnitShow(output)).toEqual({
      installed: true,
      enabled: true,
      active: true,
      fragmentPath: "/home/someone/.config/systemd/user/nexus-mission-engine.service",
    });
  });

  it("rend un état vide pour une unité inconnue", () => {
    expect(parseUnitShow("LoadState=not-found\nActiveState=inactive\nFragmentPath=")).toEqual({
      installed: false,
      enabled: false,
      active: false,
      fragmentPath: undefined,
    });
  });
});

describe("chemins d'une unité portable", () => {
  it("ne reproche pas à une unité d'utiliser les spécificateurs systemd", () => {
    // L'unité du navigateur est écrite avec `%h`, résolu par systemd au
    // chargement : elle est donc déjà portable. La signaler reviendrait à
    // reprocher à une unité d'être bien écrite — et c'était un faux positif
    // observé sur l'installation réelle.
    const portable = [
      "[Service]",
      "Environment=XDG_CONFIG_HOME=%h/.local/share/nexus/browser-xdg/config",
      "ExecStart=/usr/bin/chromium --user-data-dir=%h/.local/share/nexus/browser-profile",
      "BindPaths=%h/.local/share/nexus/browser-profile",
    ].join("\n");

    expect(foreignPaths(portable, "/opt/nexus")).toEqual([]);
  });

  it("signale malgré tout un chemin absolu d'une autre installation", () => {
    const stale = "WorkingDirectory=/ailleurs/nexus/services/mission-engine";

    expect(foreignPaths(stale, "/opt/nexus")).toEqual(["/ailleurs/nexus/services/mission-engine"]);
  });
});

describe("permissions du fichier de secrets", () => {
  it("les vérifie même sans clé de signature persistante", async () => {
    const root = workspace();
    // Cas d'une installation neuve : pas encore de clé, mais le `.env` porte
    // déjà le mot de passe PostgreSQL. Ne vérifier les permissions qu'après la
    // clé laissait passer le cas le plus courant.
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n", { mode: 0o644 });

    const groups = await runDoctor({
      paths: resolvePaths(root, join(root, "home")),
      probes: {
        tcp: () => Promise.resolve(true),
        http: () => Promise.resolve({ status: 200, body: "{}" }),
        command: () => Promise.resolve(undefined),
      },
      env: { NODE_ENV: "development" },
    });

    const security = groups.find((group) => group.title === "Sécurité");
    const permissions = security?.results.find((result) => result.name === "permissions de .env");
    expect(permissions?.status).toBe("warn");
    expect(permissions?.fix).toContain("chmod 600");
  });
});
