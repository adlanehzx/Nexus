import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile } from "../src/profiles.js";

describe("registre ACP NEXUS", () => {
  it("charge uniquement un profil structuré et développe HOME", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-acp-"));
    const registry = join(directory, "profiles.json");
    await writeFile(
      registry,
      JSON.stringify({
        profiles: {
          claude: {
            command: "${HOME}/bin/claude",
            args: ["--cwd", "${HOME}/work"],
            system_prompt: "Relis avant de répondre.",
            reasoning_effort: "high",
            additional_dirs: ["${HOME}/shared"],
            config_options: { mode: "review" },
          },
        },
      }),
      { mode: 0o600 },
    );

    const profile = await loadProfile(registry, "claude");

    expect(profile.command).toMatch(/\/bin\/claude$/);
    expect(profile.args[1]).toMatch(/\/work$/);
    expect(profile.additional_dirs[0]).toMatch(/\/shared$/);
    expect(profile.system_prompt).toBe("Relis avant de répondre.");
    expect(profile.reasoning_effort).toBe("high");
    expect(profile.config_options).toEqual({ mode: "review" });
  });

  it("refuse une clé de profil inconnue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-acp-"));
    const registry = join(directory, "profiles.json");
    await writeFile(registry, '{"profiles":{}}', { mode: 0o600 });

    await expect(loadProfile(registry, "missing")).rejects.toThrow("unknown_profile");
  });

  it("gère l'isolation de session_dir et les variables d'environnement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-acp-"));
    const registry = join(directory, "profiles.json");
    await writeFile(
      registry,
      JSON.stringify({
        profiles: {
          "claude-secondary": {
            command: "${HOME}/bin/claude",
            args: ["--config", "${SESSION_DIR}/config.json"],
            session_dir: "${HOME}/.nexus/sessions/claude-2",
            env: {
              CLAUDE_CONFIG_DIR: "${SESSION_DIR}",
              CUSTOM_VAR: "active",
            },
          },
        },
      }),
      { mode: 0o600 },
    );

    const profile = await loadProfile(registry, "claude-secondary");
    expect(profile.session_dir).toMatch(/\/\.nexus\/sessions\/claude-2$/);
    expect(profile.args[1]).toMatch(/\/\.nexus\/sessions\/claude-2\/config\.json$/);
    expect(profile.env.CLAUDE_CONFIG_DIR).toMatch(/\/\.nexus\/sessions\/claude-2$/);
    expect(profile.env.CUSTOM_VAR).toBe("active");
  });
});
