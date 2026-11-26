import type { CSSProperties } from "react";
import "./kit/NexusLogo.css";

/**
 * What NEXUS is doing, as the logo shows it.
 *
 * The names match the vocabulary the desktop application already uses for its
 * own indicator, plus `paused` and `success`. `planning` means a request is out
 * and no plan has come back: the interface has no view of the model's reasoning
 * and does not claim one.
 */
export type NexusState =
  "idle" | "planning" | "executing" | "waiting" | "error" | "offline" | "paused" | "success";

export interface NexusLogoProps {
  /** Rendered width and height in pixels. */
  size?: number;
  /** Drives the lamp. Only one logo per view should follow the live state. */
  state?: NexusState;
  /** `auto` picks the small cut at 20px and under, where the normal lamp would vanish. */
  cut?: "auto" | "normal" | "small";
  /** Accessible name. Omit for decorative use: the state is always written next to the logo. */
  label?: string;
  className?: string;
  /** For callers not yet migrated to a stylesheet. */
  style?: CSSProperties;
}

export function NexusLogo({
  size = 24,
  state = "idle",
  cut = "auto",
  label,
  className = "",
  style,
}: NexusLogoProps) {
  const small = cut === "small" || (cut === "auto" && size <= 20);
  const classes = ["nx-logo", small ? "sm" : "", className].filter(Boolean).join(" ");
  const naming =
    label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label };

  return (
    <svg
      className={classes}
      data-state={state}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      {...naming}
      {...(style === undefined ? {} : { style })}
    >
      {small ? (
        <>
          <path
            className="bezel"
            d="M19.5 3.5h-14a2 2 0 0 0-2 2v21a2 2 0 0 0 2 2h21a2 2 0 0 0 2-2V12.5"
          />
          <path className="n" d="M10 23V11.5L20.5 23V14" />
          <path className="n-gap" d="M10 23V11.5l3 3.3M17.5 19.7l3 3.3V14" />
          <path className="seg s1" d="M10 23V11.5" />
          <path className="seg s2" d="M10 11.5 20.5 23" />
          <path className="seg s3" d="M20.5 23V14" />
          <rect className="lamp" x="22.5" y="3" width="6.5" height="6.5" />
          <rect className="lamp-wide" x="22.5" y="3" width="6.5" height="6.5" />
        </>
      ) : (
        <>
          <rect className="bezel" x="2.75" y="2.75" width="26.5" height="26.5" rx="2.5" />
          <path className="n" d="M10.5 22.5v-12l10.5 12v-12" />
          <path className="n-gap" d="M10.5 22.5v-12L14.17 14.69M17.33 18.31 21 22.5v-12" />
          <path className="seg s1" d="M10.5 22.5v-12" />
          <path className="seg s2" d="M10.5 10.5 21 22.5" />
          <path className="seg s3" d="M21 22.5v-12" />
          <rect className="lamp" x="23.6" y="5.4" width="2.8" height="2.8" />
          <rect className="lamp-wide" x="20.8" y="5.4" width="5.6" height="2.8" />
        </>
      )}
    </svg>
  );
}
