import { describe, expect, it } from "vitest";
import { AppPolicy } from "../src/policy/app-policy.js";
import { UiPolicy } from "../src/policy/ui-policy.js";
import { ScreenshotPolicy } from "../src/policy/screenshot-policy.js";

/**
 * Les politiques sont la frontière réelle du worker Android.
 *
 * Les assertions portent sur le **code** d'erreur et sur la règle enfreinte,
 * jamais sur le texte du message : `code` est un contrat public et stable,
 * `message` est technique. Accrocher des tests au second les ferait échouer à la
 * première reformulation, ce qui apprend à ignorer les échecs.
 */

interface CaughtError {
  code?: string;
  userMessage?: string;
  context?: Record<string, unknown>;
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

describe("politique d'applications", () => {
  it("accepte un nom de paquet valide", () => {
    expect(new AppPolicy().assertAllowed("com.spotify.music")).toBe("com.spotify.music");
  });

  it("refuse une forme qui n'est pas un nom de paquet", () => {
    const policy = new AppPolicy();
    for (const invalid of [
      "com",
      "content://settings/secure",
      "../../etc",
      "com.app/.MainActivity",
      "intent:#Intent;action=x;end",
      "com..app",
    ]) {
      throwsWith(() => policy.assertAllowed(invalid), "WORKER_POLICY_VIOLATION", "app.packageName");
    }
  });

  it("refuse les réglages du système, même sans liste d'autorisation", () => {
    throwsWith(
      () => new AppPolicy().assertAllowed("com.android.settings"),
      "WORKER_POLICY_VIOLATION",
      "app.denied",
    );
  });

  it("refuse aussi les sous-paquets d'un paquet interdit", () => {
    throwsWith(
      () => new AppPolicy().assertAllowed("com.android.settings.suggestion"),
      "WORKER_POLICY_VIOLATION",
      "app.denied",
    );
  });

  it("refuse une application dont le nom trahit un usage sensible", () => {
    throwsWith(
      () => new AppPolicy().assertAllowed("com.exemple.passwordmanager"),
      "WORKER_POLICY_VIOLATION",
      "app.sensitive",
    );
  });

  it("le refus l'emporte sur la liste d'autorisation", () => {
    // Une liste d'autorisation mal renseignée ne doit pas rouvrir les réglages.
    const policy = new AppPolicy({ allowedPackages: ["com.android.settings"] });
    throwsWith(
      () => policy.assertAllowed("com.android.settings"),
      "WORKER_POLICY_VIOLATION",
      "app.denied",
    );
  });

  it("refuse ce qui n'est pas dans la liste d'autorisation", () => {
    const policy = new AppPolicy({ allowedPackages: ["com.spotify.music"] });
    expect(policy.allows("com.spotify.music")).toBe(true);
    throwsWith(
      () => policy.assertAllowed("com.whatsapp"),
      "WORKER_POLICY_VIOLATION",
      "app.notAllowed",
    );
  });

  it("accepte tout ce qui n'est pas refusé quand la liste est vide", () => {
    const policy = new AppPolicy();
    expect(policy.hasAllowList).toBe(false);
    expect(policy.allows("com.whatsapp")).toBe(true);
  });

  it("accepte un refus supplémentaire venu de la configuration", () => {
    const policy = new AppPolicy({ deniedPackages: ["com.whatsapp"] });
    throwsWith(() => policy.assertAllowed("com.whatsapp"), "WORKER_POLICY_VIOLATION", "app.denied");
  });
});

describe("politique d'interface", () => {
  it("accepte un sélecteur par identifiant de vue", () => {
    const selector = new UiPolicy().assertSelectorAllowed({
      kind: "viewId",
      value: "com.app:id/search",
    });
    expect(selector).toEqual({ kind: "viewId", value: "com.app:id/search" });
  });

  it("refuse les clics par coordonnées par défaut", () => {
    // Cliquer en (540, 1200) touche ce qui s'y trouve, pas ce qu'on visait.
    throwsWith(
      () => new UiPolicy().assertSelectorAllowed({ kind: "coordinates", x: 540, y: 1200 }),
      "WORKER_POLICY_VIOLATION",
      "ui.coordinatesDisabled",
    );
  });

  it("accepte les coordonnées quand la configuration les autorise", () => {
    const policy = new UiPolicy({ allowCoordinateClicks: true });
    expect(policy.assertSelectorAllowed({ kind: "coordinates", x: 10, y: 20 })).toEqual({
      kind: "coordinates",
      x: 10,
      y: 20,
    });
  });

  it("refuse des coordonnées hors de l'écran", () => {
    const policy = new UiPolicy({
      allowCoordinateClicks: true,
      screenBounds: { width: 1080, height: 2400 },
    });
    throwsWith(
      () => policy.assertSelectorAllowed({ kind: "coordinates", x: 5000, y: 10 }),
      "WORKER_POLICY_VIOLATION",
      "ui.coordinatesOutOfBounds",
    );
  });

  it("refuse un sélecteur vide", () => {
    throwsWith(
      () => new UiPolicy().assertSelectorAllowed({ kind: "text", value: "   " }),
      "WORKER_POLICY_VIOLATION",
      "ui.selectorEmpty",
    );
  });

  it("refuse un sélecteur démesuré", () => {
    throwsWith(
      () => new UiPolicy().assertSelectorAllowed({ kind: "text", value: "x".repeat(500) }),
      "WORKER_POLICY_VIOLATION",
      "ui.selectorTooLong",
    );
  });

  it("accepte un texte de saisie et le rend intact", () => {
    // Le texte doit atteindre le champ tel quel : c'est peut-être un mot de passe.
    expect(new UiPolicy().assertTextAllowed("mot de passe")).toBe("mot de passe");
  });

  it("refuse un texte vide", () => {
    throwsWith(
      () => new UiPolicy().assertTextAllowed(""),
      "WORKER_POLICY_VIOLATION",
      "ui.textEmpty",
    );
  });

  it("refuse un texte démesuré sans le recopier dans l'erreur", () => {
    const error = throwsWith(
      () => new UiPolicy({ maxInputLength: 10 }).assertTextAllowed("secret-tres-long-a-saisir"),
      "WORKER_POLICY_VIOLATION",
      "ui.textTooLong",
    );

    // L'erreur donne la longueur, jamais le contenu.
    expect(JSON.stringify(error)).not.toContain("secret-tres-long");
    expect(error.context?.length).toBe(25);
  });

  it("refuse une amplitude de défilement excessive", () => {
    throwsWith(
      () => new UiPolicy({ maxScrollAmount: 5 }).assertScrollAllowed("down", 50),
      "WORKER_POLICY_VIOLATION",
      "ui.scrollTooFar",
    );
  });

  it("refuse une amplitude non entière ou nulle", () => {
    const policy = new UiPolicy();
    throwsWith(
      () => policy.assertScrollAllowed("down", 0),
      "WORKER_POLICY_VIOLATION",
      "ui.scrollAmount",
    );
    throwsWith(
      () => policy.assertScrollAllowed("down", 1.5),
      "WORKER_POLICY_VIOLATION",
      "ui.scrollAmount",
    );
  });

  it("refuse un clic sur un élément non cliquable", () => {
    // Sans cette règle, le système propagerait le clic au parent — donc à un
    // élément qu'on n'a pas choisi.
    throwsWith(
      () => new UiPolicy().assertNodeAccepts({ clickable: false, editable: false }, "click"),
      "WORKER_POLICY_VIOLATION",
      "ui.nodeNotClickable",
    );
  });

  it("refuse une saisie dans un élément non éditable", () => {
    throwsWith(
      () => new UiPolicy().assertNodeAccepts({ clickable: true, editable: false }, "input"),
      "WORKER_POLICY_VIOLATION",
      "ui.nodeNotEditable",
    );
  });
});

describe("politique de capture d'écran", () => {
  it("autorise une première capture", () => {
    expect(() => new ScreenshotPolicy().assertCaptureAllowed()).not.toThrow();
  });

  it("refuse une capture trop rapprochée", () => {
    // La barrière contre l'enregistrement continu par accumulation.
    let now = 1_000;
    const policy = new ScreenshotPolicy({ minIntervalMs: 1_000, now: () => now });

    policy.assertCaptureAllowed();
    now += 200;
    throwsWith(() => policy.assertCaptureAllowed(), "WORKER_POLICY_VIOLATION", "screenshot.rate");
  });

  it("autorise à nouveau une fois l'intervalle écoulé", () => {
    let now = 1_000;
    const policy = new ScreenshotPolicy({ minIntervalMs: 1_000, now: () => now });

    policy.assertCaptureAllowed();
    now += 1_500;
    expect(() => policy.assertCaptureAllowed()).not.toThrow();
  });

  it("refuse une image trop lourde", () => {
    throwsWith(
      () =>
        new ScreenshotPolicy({ maxBytes: 1_000 }).assertWithinLimits({
          bytes: 5_000,
          width: 100,
          height: 100,
        }),
      "WORKER_POLICY_VIOLATION",
      "screenshot.tooLarge",
    );
  });

  it("refuse une image trop grande", () => {
    throwsWith(
      () =>
        new ScreenshotPolicy({ maxDimension: 720 }).assertWithinLimits({
          bytes: 100,
          width: 1_080,
          height: 2_400,
        }),
      "WORKER_POLICY_VIOLATION",
      "screenshot.tooBig",
    );
  });

  it("plafonne la résolution demandée, quoi qu'en dise la configuration", () => {
    expect(new ScreenshotPolicy({ maxDimension: 99_999 }).maxDimension).toBe(2_048);
  });
});
