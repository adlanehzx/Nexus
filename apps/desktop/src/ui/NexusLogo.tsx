import type { CSSProperties } from "react";

export function NexusLogo({
  size = 24,
  className = "",
  style,
  ariaHidden = true,
}: {
  size?: number | string;
  className?: string;
  style?: CSSProperties;
  ariaHidden?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 440 440"
      className={`nexus-brand-logo ${className}`.trim()}
      role="img"
      aria-label="NEXUS"
      aria-hidden={ariaHidden ? "true" : undefined}
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        flexShrink: 0,
        ...style,
      }}
    >
      <title>NEXUS</title>
      <g transform="translate(-405 -320)">
        <path fill="currentColor" d="M452 391H554L735 571V438L800 372V687L569 454H515Z" />
        <path fill="currentColor" d="M473 455L538 520V638L473 704Z" opacity="0.88" />
        <path fill="var(--color-brand-cyan, #02E9E9)" d="M530 484H572L747 659H706Z" />
      </g>
    </svg>
  );
}
