import { describe, expect, it } from "vitest";
import { AppPolicy } from "../src/policy/app-policy.js";
import { UiPolicy } from "../src/policy/ui-policy.js";
import { ScreenshotPolicy } from "../src/policy/screenshot-policy.js";

/**
 * Policies are the real perimeter of the Android worker.
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

describe("application policy", () => {
  it("accepts a valid package name", () => {
    expect(new AppPolicy().assertAllowed("com.spotify.music")).toBe("com.spotify.music");
  });

  it("rejects non-package name syntax", () => {
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

  it("rejects system settings, even without an allowlist", () => {
    throwsWith(
      () => new AppPolicy().assertAllowed("com.android.settings"),
      "WORKER_POLICY_VIOLATION",
      "app.denied",
    );
  });

  it("also rejects subpackages of a forbidden package", () => {
    throwsWith(
      () => new AppPolicy().assertAllowed("com.android.settings.suggestion"),
      "WORKER_POLICY_VIOLATION",
      "app.denied",
    );
  });

  it("rejects an application whose name suggests sensitive usage", () => {
    throwsWith(
      () => new AppPolicy().assertAllowed("com.example.passwordmanager"),
      "WORKER_POLICY_VIOLATION",
      "app.sensitive",
    );
  });

  it("denial takes precedence over allowlist", () => {
    const policy = new AppPolicy({ allowedPackages: ["com.android.settings"] });
    throwsWith(
      () => policy.assertAllowed("com.android.settings"),
      "WORKER_POLICY_VIOLATION",
      "app.denied",
    );
  });

  it("rejects what is not in the allowlist", () => {
    const policy = new AppPolicy({ allowedPackages: ["com.spotify.music"] });
    expect(policy.allows("com.spotify.music")).toBe(true);
    throwsWith(
      () => policy.assertAllowed("com.whatsapp"),
      "WORKER_POLICY_VIOLATION",
      "app.notAllowed",
    );
  });

  it("accepts anything not denied when allowlist is empty", () => {
    const policy = new AppPolicy();
    expect(policy.hasAllowList).toBe(false);
    expect(policy.allows("com.whatsapp")).toBe(true);
  });

  it("accepts additional denial from configuration", () => {
    const policy = new AppPolicy({ deniedPackages: ["com.whatsapp"] });
    throwsWith(() => policy.assertAllowed("com.whatsapp"), "WORKER_POLICY_VIOLATION", "app.denied");
  });
});

describe("UI policy", () => {
  it("accepts a selector by view ID", () => {
    const selector = new UiPolicy().assertSelectorAllowed({
      kind: "viewId",
      value: "com.app:id/search",
    });
    expect(selector).toEqual({ kind: "viewId", value: "com.app:id/search" });
  });

  it("rejects coordinate clicks by default", () => {
    throwsWith(
      () => new UiPolicy().assertSelectorAllowed({ kind: "coordinates", x: 540, y: 1200 }),
      "WORKER_POLICY_VIOLATION",
      "ui.coordinatesDisabled",
    );
  });

  it("accepts coordinates when allowed by configuration", () => {
    const policy = new UiPolicy({ allowCoordinateClicks: true });
    expect(policy.assertSelectorAllowed({ kind: "coordinates", x: 10, y: 20 })).toEqual({
      kind: "coordinates",
      x: 10,
      y: 20,
    });
  });

  it("rejects coordinates outside screen bounds", () => {
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

  it("rejects empty selector", () => {
    throwsWith(
      () => new UiPolicy().assertSelectorAllowed({ kind: "text", value: "   " }),
      "WORKER_POLICY_VIOLATION",
      "ui.selectorEmpty",
    );
  });

  it("rejects oversized selector", () => {
    throwsWith(
      () => new UiPolicy().assertSelectorAllowed({ kind: "text", value: "x".repeat(500) }),
      "WORKER_POLICY_VIOLATION",
      "ui.selectorTooLong",
    );
  });

  it("accepts input text and returns it intact", () => {
    expect(new UiPolicy().assertTextAllowed("password")).toBe("password");
  });

  it("rejects empty text", () => {
    throwsWith(
      () => new UiPolicy().assertTextAllowed(""),
      "WORKER_POLICY_VIOLATION",
      "ui.textEmpty",
    );
  });

  it("rejects oversized text without copying it into the error", () => {
    const error = throwsWith(
      () => new UiPolicy({ maxInputLength: 10 }).assertTextAllowed("very-long-secret-to-input"),
      "WORKER_POLICY_VIOLATION",
      "ui.textTooLong",
    );

    expect(JSON.stringify(error)).not.toContain("very-long-secret");
    expect(error.context?.length).toBe(25);
  });

  it("rejects excessive scroll amount", () => {
    throwsWith(
      () => new UiPolicy({ maxScrollAmount: 5 }).assertScrollAllowed("down", 50),
      "WORKER_POLICY_VIOLATION",
      "ui.scrollTooFar",
    );
  });

  it("rejects non-integer or zero scroll amount", () => {
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

  it("rejects click on non-clickable element", () => {
    throwsWith(
      () => new UiPolicy().assertNodeAccepts({ clickable: false, editable: false }, "click"),
      "WORKER_POLICY_VIOLATION",
      "ui.nodeNotClickable",
    );
  });

  it("rejects input into non-editable element", () => {
    throwsWith(
      () => new UiPolicy().assertNodeAccepts({ clickable: true, editable: false }, "input"),
      "WORKER_POLICY_VIOLATION",
      "ui.nodeNotEditable",
    );
  });
});

describe("screenshot policy", () => {
  it("authorizes a first screenshot", () => {
    expect(() => new ScreenshotPolicy().assertCaptureAllowed()).not.toThrow();
  });

  it("rejects too frequent capture", () => {
    let now = 1_000;
    const policy = new ScreenshotPolicy({ minIntervalMs: 1_000, now: () => now });

    policy.assertCaptureAllowed();
    now += 200;
    throwsWith(() => policy.assertCaptureAllowed(), "WORKER_POLICY_VIOLATION", "screenshot.rate");
  });

  it("authorizes again once interval has elapsed", () => {
    let now = 1_000;
    const policy = new ScreenshotPolicy({ minIntervalMs: 1_000, now: () => now });

    policy.assertCaptureAllowed();
    now += 1_500;
    expect(() => policy.assertCaptureAllowed()).not.toThrow();
  });

  it("rejects image exceeding byte size limit", () => {
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

  it("rejects image exceeding dimension limit", () => {
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

  it("caps requested resolution regardless of configuration", () => {
    expect(new ScreenshotPolicy({ maxDimension: 99_999 }).maxDimension).toBe(2_048);
  });
});
