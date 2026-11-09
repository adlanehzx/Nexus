/**
 * Resolve a CSS colour (hex, rgb(), a `var()` chain) to its 0-255 RGB triplet.
 *
 * Canvas 2D drawing cannot use `var(--token)` or `color-mix()`, so a canvas that
 * must follow the active colour theme reads the token through a throw-away probe
 * element, which makes the browser do the resolution.
 */
export type Rgb = readonly [number, number, number];

const CYAN_FALLBACK: Rgb = [0, 240, 255];

export function readCssColorRgb(cssColor: string, fallback: Rgb = CYAN_FALLBACK): Rgb {
  if (typeof document === "undefined" || !document.body) return fallback;
  const probe = document.createElement("span");
  probe.style.color = cssColor;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const channels = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(resolved);
  if (channels === null) return fallback;
  return [
    Math.round(Number(channels[1])),
    Math.round(Number(channels[2])),
    Math.round(Number(channels[3])),
  ];
}

/** The active theme's signal colour. */
export function readSignalRgb(): Rgb {
  return readCssColorRgb("var(--nx-signal)");
}

/** Run `onChange` whenever the colour theme or light/dark mode changes. Returns a disposer. */
export function watchThemeChange(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-color-theme", "style"],
  });
  return () => observer.disconnect();
}
