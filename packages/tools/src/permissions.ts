import { z } from "zod";

/**
 * Permissions.
 * Format is a dotted domain.action identifier.
 */
export type Permission = `${string}.${string}`;

export const permissionSchema = z
  .string()
  .regex(/^[a-z0-9_-]+(\.[a-z0-9_*-]+)+$/, "expected format: domain.action")
  .transform((value) => value as Permission);

/** Catalog of standard known core permissions. */
export const PERMISSIONS = {
  calendarRead: "calendar.read",
  calendarWrite: "calendar.write",
  emailRead: "email.read",
  emailSend: "email.send",
  filesystemRead: "filesystem.read",
  filesystemWrite: "filesystem.write",
  terminalExecute: "terminal.execute",
  browserNavigate: "browser.navigate",
  browserInteract: "browser.interact",
  githubRead: "github.read",
  githubWrite: "github.write",
  memoryRead: "memory.read",
  memoryWrite: "memory.write",
} as const satisfies Record<string, Permission>;

export type KnownPermission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Tests whether a granted permission covers a required permission. */
export function permissionCovers(granted: string, required: string): boolean {
  if (granted === "*") return true;
  if (granted === required) return true;

  const wildcard = granted.endsWith(".*") ? granted.slice(0, -1) : undefined;
  return wildcard !== undefined && required.startsWith(wildcard);
}

/** Returns required permissions not covered by any granted permission. */
export function missingPermissions(
  granted: readonly string[],
  required: readonly string[],
): string[] {
  return required.filter((need) => !granted.some((have) => permissionCovers(have, need)));
}
