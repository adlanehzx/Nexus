import { z } from "zod";

/**
 * Permissions.
 *
 * Une permission est un identifiant pointé `domaine.action`. Le type garantit la
 * forme à la compilation pour les littéraux, tout en laissant la porte ouverte
 * aux outils découverts dynamiquement (MCP), qui déclarent leurs propres clés.
 */
export type Permission = `${string}.${string}`;

export const permissionSchema = z
  .string()
  .regex(/^[a-z0-9_-]+(\.[a-z0-9_*-]+)+$/, "forme attendue : domaine.action")
  .transform((value) => value as Permission);

/**
 * Catalogue des permissions connues du cœur.
 *
 * Il documente ce qui existe et alimente l'interface de réglages ; il ne
 * **restreint** pas ce qu'un outil peut exiger — un serveur MCP déclarera
 * `mcp.<serveur>.<outil>` sans figurer ici.
 */
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

/**
 * Une permission accordée couvre-t-elle une permission requise ?
 *
 * Formes acceptées côté accordé :
 *   `calendar.read`  — exacte
 *   `calendar.*`     — tout le domaine
 *   `*`              — tout (réservé à l'administration, jamais un défaut)
 *
 * Le joker n'existe que du côté **accordé**. Un outil qui exigerait
 * `calendar.*` demanderait « une permission quelconque du domaine », ce qui ne
 * veut rien dire : les exigences sont toujours explicites.
 */
export function permissionCovers(granted: string, required: string): boolean {
  if (granted === "*") return true;
  if (granted === required) return true;

  const wildcard = granted.endsWith(".*") ? granted.slice(0, -1) : undefined;
  return wildcard !== undefined && required.startsWith(wildcard);
}

/** Permissions requises qui ne sont couvertes par aucune permission accordée. */
export function missingPermissions(
  granted: readonly string[],
  required: readonly string[],
): string[] {
  return required.filter((need) => !granted.some((have) => permissionCovers(have, need)));
}
