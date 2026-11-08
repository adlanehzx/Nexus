import type { CSSProperties } from "react";

export interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  color?: string;
}

const baseProps = (size = 16, color?: string, style?: CSSProperties, className?: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: color ?? "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: `cyber-svg-icon ${className ?? ""}`.trim(),
  style: { display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style },
  "aria-hidden": true as const,
});

export function IconInbox({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

export function IconScales({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="M7 21h10" />
      <path d="M12 3v18" />
      <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
    </svg>
  );
}

export function IconKanban({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <rect x="3" y="4" width="5" height="16" rx="1.5" />
      <rect x="10" y="4" width="5" height="11" rx="1.5" />
      <rect x="17" y="4" width="5" height="14" rx="1.5" />
    </svg>
  );
}

export function IconDocument({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

export function IconCalendar({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

export function IconAnalytics({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
      <line x1="3" y1="20" x2="21" y2="20" />
    </svg>
  );
}

export function IconShield({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function IconTarget({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

export function IconLab({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M10 2v7.5L4.5 19.5A2 2 0 0 0 6.2 22h11.6a2 2 0 0 0 1.7-2.5L14 9.5V2" />
      <path d="M8.5 2h7" />
      <path d="M7 16h10" />
      <circle cx="10" cy="12" r="0.75" fill="currentColor" />
      <circle cx="13.5" cy="14" r="0.75" fill="currentColor" />
    </svg>
  );
}

export function IconUsage({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M12 14.5l3.5-3.5" />
      <path d="M3.34 18a10 10 0 1 1 17.32 0" />
      <circle cx="12" cy="14.5" r="2" />
      <line x1="12" y1="4" x2="12" y2="6" />
      <line x1="5.64" y1="7.64" x2="7.05" y2="9.05" />
      <line x1="18.36" y1="7.64" x2="16.95" y2="9.05" />
    </svg>
  );
}

export function IconSettings({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function IconBolt({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

export function IconWarning({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function IconCheck({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function IconClose({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function IconStar({
  size = 16,
  color,
  filled = false,
  style,
  className,
}: IconProps & { filled?: boolean }) {
  const p = baseProps(size, color, style, className);
  return (
    <svg {...p} fill={filled ? (color ?? "currentColor") : "none"}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

export function IconSearch({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function IconClock({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function IconStop({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
      <rect x="9" y="9" width="6" height="6" fill={color ?? "currentColor"} />
    </svg>
  );
}

export function IconGlobe({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

export function IconMail({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  );
}

export function IconNote({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

export function IconBarChart({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
    </svg>
  );
}

export function IconEye({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconRefresh({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
    </svg>
  );
}

export function IconMaximize({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

export function IconMinimize({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

export function IconPin({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V5a3 3 0 0 0-6 0v5.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

export function IconMap({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
      <line x1="8" y1="2" x2="8" y2="18" />
      <line x1="16" y1="6" x2="16" y2="22" />
    </svg>
  );
}

export function IconArrowRight({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

export function IconAnthropic({ size = 16, color, style, className }: IconProps) {
  return (
    <svg
      {...baseProps(size, color, style, className)}
      viewBox="0 0 24 24"
      fill={color ?? "currentColor"}
      stroke="none"
    >
      <path d="M13.83 3.5h3.42L24 20.5h-3.42l-1.89-4.82h-7.38L9.42 20.5H6L13.83 3.5zm2.5 10.63-2.5-6.52-2.5 6.52h5z" />
      <path d="M4.62 3.5H8.1L3.48 20.5H0L4.62 3.5z" />
    </svg>
  );
}

export function IconOpenAI({ size = 16, color, style, className }: IconProps) {
  return (
    <svg
      {...baseProps(size, color, style, className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth={1.8}
    >
      <path d="M12 2a4.5 4.5 0 0 1 4.24 3.02l.2.6a4.5 4.5 0 0 1 2.38 5.48l-.34.7a4.5 4.5 0 0 1-.2 5.98l-.66.52a4.5 4.5 0 0 1-5.38 2.6l-.74-.26a4.5 4.5 0 0 1-5.96-2.38l-.2-.62a4.5 4.5 0 0 1-.74-5.92l.48-.68a4.5 4.5 0 0 1 2.64-5.36l.72.26A4.5 4.5 0 0 1 12 2Z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

export function IconGemini({ size = 16, color, style, className }: IconProps) {
  return (
    <svg
      {...baseProps(size, color, style, className)}
      viewBox="0 0 24 24"
      fill={color ?? "currentColor"}
      stroke="none"
    >
      <path d="M12 1C12 7.075 7.075 12 1 12c6.075 0 11 4.925 11 11 0-6.075 4.925-11 11-11-6.075 0-11-4.925-11-11Z" />
    </svg>
  );
}

export function IconNvidia({ size = 16, color, style, className }: IconProps) {
  return (
    <svg
      {...baseProps(size, color, style, className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth={1.8}
    >
      <path d="M4 12c0-4.42 3.58-8 8-8s8 3.58 8 8-3.58 8-8 8-8-3.58-8-8Z" />
      <path d="M7.5 12c0-2.49 2.01-4.5 4.5-4.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5" />
      <circle cx="12" cy="12" r="1.8" fill={color ?? "currentColor"} />
    </svg>
  );
}

export function IconCpu({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)} viewBox="0 0 24 24">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}

export function IconBrain({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)} viewBox="0 0 24 24">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04Z" />
    </svg>
  );
}

export function IconCopy({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)} viewBox="0 0 24 24">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function IconExternalLink({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)} viewBox="0 0 24 24">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

export function IconGitHub({ size = 16, color, style, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={`cyber-svg-icon ${className ?? ""}`.trim()}
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        flexShrink: 0,
        color: color ?? "currentColor",
        ...style,
      }}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

export function IconSlack({ size = 16, color, style, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={`cyber-svg-icon ${className ?? ""}`.trim()}
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        flexShrink: 0,
        color: color ?? "currentColor",
        ...style,
      }}
      aria-hidden="true"
    >
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

export function IconGoogleDrive({ size = 16, color, style, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={`cyber-svg-icon ${className ?? ""}`.trim()}
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        flexShrink: 0,
        color: color ?? "currentColor",
        ...style,
      }}
      aria-hidden="true"
    >
      <path d="M7.71 3.5L1.15 15l3.43 6 6.55-11.5L7.71 3.5zm3.14 0l6.56 11.5H4.14l3.14-5.5h6.29l-2.72-6zM15.43 8.5l5.14 9H7.43l3.43-6h8.57z" />
    </svg>
  );
}

export function IconLinear({ size = 16, color, style, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={`cyber-svg-icon ${className ?? ""}`.trim()}
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        flexShrink: 0,
        color: color ?? "currentColor",
        ...style,
      }}
      aria-hidden="true"
    >
      <path d="M3.5 12a8.5 8.5 0 1 1 17 0 8.5 8.5 0 0 1-17 0zm8.5-6.5a6.5 6.5 0 0 0-4.6 11.1l11.1-11.1A6.47 6.47 0 0 0 12 5.5z" />
    </svg>
  );
}

export function IconNotion({ size = 16, color, style, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={`cyber-svg-icon ${className ?? ""}`.trim()}
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        flexShrink: 0,
        color: color ?? "currentColor",
        ...style,
      }}
      aria-hidden="true"
    >
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l11.144-.654c1.12-.093 1.4.28 1.12 1.213l-2.054 11.95c-.187 1.027-.746 1.4-1.773 1.493l-11.75.654c-1.027.093-1.4-.28-1.214-1.307l2.1-13.815zm3.64 3.734l-1.4 8.775 3.36-.187 1.027-6.254 3.733 6.067 2.8-.187 1.4-8.774-3.08.187-.933 6.067-3.92-5.88z" />
    </svg>
  );
}

export function IconJob({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <rect x="3" y="7" width="18" height="14" rx="2" />
      <path d="M8 7V3h8v4M3 12h18M10 12v3h4v-3" />
    </svg>
  );
}

export function IconEducation({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="m2 8 10-5 10 5-10 5-10-5ZM6 10v7c4 3 8 3 12 0v-7M22 8v9" />
    </svg>
  );
}

export function IconPause({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

export function IconPlay({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

export function IconPower({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

export function IconSnowflake({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <line x1="12" y1="2" x2="12" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
      <line x1="19.07" y1="4.93" x2="4.93" y2="19.07" />
    </svg>
  );
}

export function IconWifi({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}

export function IconBattery({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <rect x="2" y="7" width="16" height="10" rx="2" ry="2" />
      <line x1="22" y1="11" x2="22" y2="13" />
    </svg>
  );
}

export function IconBatteryCharging({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M5 18H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.19M15 6h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3.19" />
      <line x1="23" y1="11" x2="23" y2="13" />
      <polyline points="11 6 7 12 13 12 9 18" />
    </svg>
  );
}

export function IconMic({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

export function IconMicOff({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

export function IconVolume({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

export function IconVolumeX({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}

export function IconSatellite({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <path d="M4 10a7.5 7.5 0 0 0 10 10" />
      <path d="M4 6a11.5 11.5 0 0 0 14 14" />
      <path d="M4 2a15.5 15.5 0 0 0 18 18" />
      <circle cx="4" cy="20" r="2" />
    </svg>
  );
}

export function IconHardware({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}

export function IconRadio({ size = 16, color, style, className }: IconProps) {
  return (
    <svg {...baseProps(size, color, style, className)}>
      <circle cx="12" cy="12" r="2" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
    </svg>
  );
}
