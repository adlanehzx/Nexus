import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";

const profileSchema = z.object({
  name: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  model: z.string().min(1).optional(),
  system_prompt: z.string().max(32_000).optional(),
  reasoning_effort: z
    .enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
    .optional(),
  additional_dirs: z.array(z.string()).max(32).default([]),
  config_options: z.record(z.string(), z.string()).default({}),
});

const registrySchema = z.object({
  profiles: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), profileSchema),
});

export type AcpProfile = z.infer<typeof profileSchema>;

function expand(value: string): string {
  return value.replaceAll("${HOME}", homedir());
}

export async function loadProfile(path: string, key: string): Promise<AcpProfile> {
  const parsed = registrySchema.parse(JSON.parse(await readFile(path, "utf8")));
  const profile = parsed.profiles[key];
  if (profile === undefined) throw new Error("unknown_profile");
  return {
    ...profile,
    command: expand(profile.command),
    args: profile.args.map(expand),
    additional_dirs: profile.additional_dirs.map(expand),
  };
}
