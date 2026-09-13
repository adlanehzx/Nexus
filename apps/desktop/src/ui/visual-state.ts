import type { NexusOrbState } from "./NexusOrb.js";

/** Maps public UI state only; it never claims to visualise model reasoning. */
export function nexusVisualState(input: {
  online: boolean;
  connection: string;
  activeTasks: number;
  waitingConfirmations: number;
  voiceState: string;
  lastError: string | null;
}): NexusOrbState {
  if (!input.online || input.connection === "disconnected") return "offline";
  if (input.lastError !== null) return "error";
  if (input.waitingConfirmations > 0) return "waiting";
  if (input.voiceState === "listening") return "listening";
  if (input.activeTasks > 0) return "executing";
  if (input.connection === "connecting") return "planning";
  return "idle";
}
