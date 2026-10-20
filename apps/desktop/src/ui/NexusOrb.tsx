export type NexusOrbState =
  | "idle"
  | "listening"
  | "thinking"
  | "planning"
  | "executing"
  | "waiting"
  | "success"
  | "error"
  | "offline";

/** Lightweight visual presence; CSS layers avoid a permanent WebGL loop. */
export function NexusOrb({
  state = "idle",
  label,
  compact = false,
}: {
  state?: NexusOrbState;
  label?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`nexus-orb ${compact ? "nexus-orb--compact" : ""}`}
      data-state={state}
      role="img"
      aria-label={label ?? `NEXUS : ${state}`}
    >
      <span className="nexus-orb__halo" />
      <span className="nexus-orb__field" />
      <span className="nexus-orb__core" />
      <span className="nexus-orb__spark" />
    </div>
  );
}
