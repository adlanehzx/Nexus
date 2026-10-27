import { z } from "zod";

export const sherlockUsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z0-9_.-]+$/,
    "A username may contain only letters, digits, dots, dashes and underscores.",
  );

export const sherlockFindingSchema = z.object({
  site: z.string().min(1).max(200),
  profileUrl: z.string().url(),
});
export type SherlockFinding = z.infer<typeof sherlockFindingSchema>;

export const sherlockResultSchema = z.object({
  username: sherlockUsernameSchema,
  findings: z.array(sherlockFindingSchema).max(1_000),
  checkedAt: z.string().datetime(),
  tool: z.literal("sherlock"),
  toolVersion: z.string().max(80),
  provenance: z.literal("https://github.com/sherlock-project/sherlock"),
});
export type SherlockResult = z.infer<typeof sherlockResultSchema>;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Parse only positive Sherlock result lines; progress and failure lines are discarded. */
export function parseSherlockOutput(output: string): SherlockFinding[] {
  const byUrl = new Map<string, SherlockFinding>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI, "").trim();
    const match = /^\[\+\]\s+([^:]{1,200}):\s+(https?:\/\/\S+)$/i.exec(line);
    if (match === null) continue;
    const parsed = sherlockFindingSchema.safeParse({
      site: match[1]?.trim(),
      profileUrl: match[2],
    });
    if (parsed.success) byUrl.set(parsed.data.profileUrl, parsed.data);
  }
  return [...byUrl.values()];
}
