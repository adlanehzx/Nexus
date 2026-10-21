import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * L'hôte Android — le Kotlin qui porte le worker.
 *
 * Ces vérifications portent sur des **propriétés d'architecture**, pas sur des
 * comportements : « le service de premier plan n'est pas un exécutant parallèle »
 * ne se démontre pas en l'appelant, mais en constatant que rien ne peut s'y lier
 * et qu'aucun chemin ne mène d'un récepteur de diffusion à une capacité.
 *
 * Elles s'écrivent donc sur le source. C'est le même parti que `security.test.ts`
 * prend déjà pour le manifeste, et pour la même raison : une absence se prouve
 * en lisant tout, pas en essayant une fois.
 *
 * **Ce que ces tests ne prouvent pas** : que le Kotlin se comporte comme prévu
 * sur un téléphone. Ils prouvent qu'il ne contient pas ce qu'il ne doit pas
 * contenir. Le comportement, lui, s'observe sur appareil — le README en tient la
 * liste.
 */

const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const KOTLIN = path.join(ROOT, "android", "src", "main", "kotlin", "fr", "nexus", "worker");

function kotlin(name: string): string {
  return readFileSync(path.join(KOTLIN, `${name}.kt`), "utf8");
}

/** Retire les commentaires : on juge le code, pas ce qu'il dit de lui-même. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function manifest(): string {
  return readFileSync(path.join(ROOT, "android", "AndroidManifest.xml"), "utf8").replace(
    /<!--[\s\S]*?-->/g,
    "",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Les classes déclarées au manifeste existent
// ─────────────────────────────────────────────────────────────────────────────

describe("cohérence du manifeste", () => {
  it("chaque classe déclarée existe réellement", () => {
    // Un manifeste qui nomme une classe absente produit un APK qui ne s'installe
    // pas — et l'erreur n'apparaît qu'au moment de l'installation, loin de la
    // cause. Ce test la rapproche.
    const declared = [...manifest().matchAll(/android:name="\.([A-Za-z0-9_]+)"/g)].map(
      (match) => match[1]!,
    );

    expect(declared.length).toBeGreaterThan(0);

    for (const name of declared) {
      expect(existsSync(path.join(KOTLIN, `${name}.kt`)), `${name}.kt manquant`).toBe(true);
    }
  });

  it("le projet Gradle existe et déclare l'espace de noms hors du manifeste", () => {
    // Depuis le greffon Android 8, `package=` au manifeste est une erreur de
    // compilation : l'espace de noms appartient au fichier de construction.
    const build = readFileSync(path.join(ROOT, "android", "app", "build.gradle.kts"), "utf8");

    expect(build).toContain('namespace = "fr.nexus.worker"');
    expect(manifest()).not.toContain("package=");
  });

  it("ne demande pas la permission de dessiner par-dessus les autres applications", () => {
    // React Native l'ajoute à la variante de débogage, pour son menu de
    // développement. Combinée au service d'accessibilité, elle permettrait de
    // superposer une fenêtre pendant qu'un appui est simulé — le montage exact
    // d'une attaque par superposition. Le manifeste la retire explicitement.
    expect(manifest()).toContain('android:name="android.permission.SYSTEM_ALERT_WINDOW"');
    expect(manifest()).toContain('tools:node="remove"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Le service de premier plan n'est pas un second exécutant
// ─────────────────────────────────────────────────────────────────────────────

describe("service de premier plan", () => {
  it("n'expose aucun canal de liaison", () => {
    // La propriété structurelle : `onBind` renvoie `null`, donc rien — ni une
    // application tierce, ni notre propre code — ne peut s'y attacher pour lui
    // envoyer un ordre.
    const source = stripComments(kotlin("WorkerForegroundService"));
    expect(source).toMatch(/override fun onBind\([^)]*\): IBinder\? = null/);
  });

  it("n'est pas exporté", () => {
    expect(manifest()).toMatch(
      /<service[\s\S]{0,200}android:name="\.WorkerForegroundService"[\s\S]{0,200}android:exported="false"/,
    );
  });

  it("n'exécute aucune capacité", () => {
    // Le point de l'architecture : le service gère un cycle de vie. Le chemin
    // vers une capacité part du cœur et passe par `WorkerRuntime` — il ne part
    // jamais d'ici.
    const source = stripComments(kotlin("WorkerForegroundService"));

    expect(source).not.toMatch(/CapabilityRegistry|executeCapability|performClick|takeScreenshot/);
    expect(source).not.toMatch(/NexusAccessibilityService/);
    expect(source).not.toMatch(/Runtime\.getRuntime|ProcessBuilder|exec\(/);
  });

  it("ne reconnaît que démarrer et arrêter", () => {
    // Deux actions, et aucun champ à lire dans l'intention : il n'y a pas de
    // « commande » transportable. Une intention inconnue est ignorée.
    const source = stripComments(kotlin("WorkerForegroundService"));

    const actions = [...source.matchAll(/const val ACTION_[A-Z_]+ =/g)];
    expect(actions).toHaveLength(2);

    expect(source).not.toMatch(/getStringExtra|getBundleExtra|getSerializableExtra/);
  });

  it("n'affiche aucun contenu de tâche dans sa notification", () => {
    // Une notification permanente s'affiche sur un écran verrouillé. Un titre
    // de tâche peut contenir un nom, une adresse, un fichier.
    const source = stripComments(kotlin("WorkerForegroundService"));
    expect(source).toContain("VISIBILITY_SECRET");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Le récepteur de démarrage
// ─────────────────────────────────────────────────────────────────────────────

describe("récepteur de démarrage", () => {
  it("vérifie l'action reçue", () => {
    // `BOOT_COMPLETED` est une diffusion protégée, mais un récepteur exporté
    // reçoit ce qu'on lui envoie et ne doit pas agir sur une intention qu'il
    // n'attendait pas.
    const source = stripComments(kotlin("BootReceiver"));
    expect(source).toContain("intent.action != Intent.ACTION_BOOT_COMPLETED");
  });

  it("ne fait que démarrer le service", () => {
    // Une capacité exécutée depuis ici tournerait hors de toute session : sans
    // authentification, sans autorisation, sans tâche. Un redémarrage du
    // téléphone deviendrait un déclencheur d'action.
    const source = stripComments(kotlin("BootReceiver"));

    expect(source).toContain("WorkerForegroundService.start");
    expect(source).not.toMatch(/NexusAccessibilityService|NexusWorkerModule|performClick|openApp/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L'enregistrement du module natif
// ─────────────────────────────────────────────────────────────────────────────

describe("surface native", () => {
  it("n'enregistre qu'un seul module", () => {
    // Ce fichier est le point exact où le JavaScript se voit accorder l'accès au
    // système. La liste tient en une ligne, et c'est la propriété qu'on garde.
    const source = stripComments(kotlin("NexusWorkerPackage"));

    expect(source).toContain("listOf(NexusWorkerModule(reactContext))");
    expect(source).toContain("emptyList()");
  });

  it("n'utilise pas l'autolinking", () => {
    // Une bibliothèque native introduite par transitivité n'est pas un détail
    // sur un appareil qui détient un service d'accessibilité : la liste des
    // paquets est écrite à la main pour qu'aucune ne s'y ajoute sans revue.
    const application = stripComments(kotlin("NexusWorkerApplication"));

    // Deux paquets, nommés : ceux de React Native, et le nôtre.
    expect(application).toContain("MainReactPackage()");
    expect(application).toContain("NexusWorkerPackage()");

    // `PackageList` est la classe générée par l'autolinking. Son absence est la
    // propriété qu'on garde : rien ne peut s'ajouter à la liste sans qu'on
    // l'écrive.
    expect(application).not.toContain("PackageList");

    const build = readFileSync(path.join(ROOT, "android", "app", "build.gradle.kts"), "utf8");
    expect(build).not.toContain("autolinkLibrariesWithApp");
  });

  it("l'activité n'exécute aucune capacité", () => {
    const source = stripComments(kotlin("WorkerActivity"));
    expect(source).not.toMatch(/NexusAccessibilityService|NexusWorkerModule|openApp|performClick/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Aucun secret dans les fichiers de construction
// ─────────────────────────────────────────────────────────────────────────────

describe("aucun secret versionné", () => {
  const gradle = () =>
    [
      path.join(ROOT, "android", "app", "build.gradle.kts"),
      path.join(ROOT, "android", "build.gradle.kts"),
      path.join(ROOT, "android", "settings.gradle.kts"),
      path.join(ROOT, "android", "gradle.properties"),
    ].map((fichier) => ({ fichier, contenu: readFileSync(fichier, "utf8") }));

  it("aucune valeur de signature en littéral", () => {
    // La version précédente interdisait les **identifiants**
    // (`storePassword`, `keyPassword`, `storeFile`). C'était trop large : signer
    // une publication exige de nommer ces propriétés Gradle, et la règle
    // interdisait donc la seule façon correcte de signer en même temps que la
    // mauvaise.
    //
    // Ce qui doit être interdit est la **valeur** : un mot de passe ou un chemin
    // de keystore écrit en clair dans un fichier versionné. Lire
    // `System.getenv(...)` est au contraire exactement ce qu'on veut.
    for (const { fichier, contenu } of gradle()) {
      expect(contenu, fichier).not.toMatch(
        /(storePassword|keyPassword|storeFile|keyAlias)\s*=\s*"[^"]/,
      );
      // Un mot de passe déposé dans `gradle.properties` serait la voie la plus
      // naturelle, et la pire : ce fichier est versionné.
      expect(contenu, fichier).not.toMatch(/^[A-Za-z_]*(?:KEYSTORE|KEY)_PASSWORD\s*=/m);
    }
  });

  it("la signature vient de l'environnement, et de rien d'autre", () => {
    const app = gradle().find((entry) =>
      entry.fichier.endsWith(path.join("app", "build.gradle.kts")),
    );
    expect(app).toBeDefined();
    const contenu = app?.contenu ?? "";

    // L'assertion positive compte autant que l'interdiction : sans elle, un
    // jour quelqu'un câblerait la signature sur un fichier local du dépôt, ce
    // qui ne déclencherait aucune des règles ci-dessus.
    for (const variable of [
      "NEXUS_KEYSTORE_PATH",
      "NEXUS_KEYSTORE_PASSWORD",
      "NEXUS_KEY_ALIAS",
      "NEXUS_KEY_PASSWORD",
    ]) {
      expect(contenu, variable).toContain(`System.getenv("${variable}")`);
    }

    // Et sans keystore complet, l'APK n'est pas signé : un artefact qui refuse
    // de s'installer vaut mieux qu'une clé versionnée.
    expect(contenu).toMatch(/signingConfig\s*=\s*if\s*\(signingReady\)/);
  });

  it("le fichier de réglages embarqué ne contient qu'un alias de clé", () => {
    // La clé de l'appareil est une **référence** dans le magasin de clés
    // d'Android. Rien de secret ne peut donc figurer dans ce fichier — et rien
    // n'y figure.
    const config = JSON.parse(readFileSync(path.join(ROOT, "nexus.config.json"), "utf8")) as Record<
      string,
      string
    >;

    expect(config.DEVICE_KEY_ALIAS).toBe("nexus.device.key");

    for (const [clef, valeur] of Object.entries(config)) {
      expect(clef, "aucune variable ne doit porter un secret").not.toMatch(
        /SECRET|TOKEN|PASSWORD|PRIVATE_KEY/i,
      );
      expect(String(valeur)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    }
  });
});
