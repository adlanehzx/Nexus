import { describe, expect, it } from "vitest";
import { AudioNotDeletedError, AudioScratch } from "../src/scratch.js";
import { FakeFiles } from "./fakes.js";

/**
 * Verifies the guaranteed ephemeral lifecycle of audio recordings.
 */

function scratch(options: { retention?: "none" | "diagnostic" } = {}) {
  const files = new FakeFiles();
  const retained: string[] = [];
  let index = 0;
  const audio = new AudioScratch({
    files,
    directory: "/tmp/nexus-audio",
    ...(options.retention === undefined ? {} : { retention: options.retention }),
    newName: () => {
      index += 1;
      return `dictation-${String(index)}.wav`;
    },
    onRetained: (path) => retained.push(path),
  });
  return { audio, files, retained };
}

describe("retention 'none' (default)", () => {
  it("deletes the recording after normal usage", async () => {
    const { audio, files } = scratch();
    const seen = await audio.withAudio((path) => {
      files.files.set(path, 64_000);
      return Promise.resolve(path);
    });

    expect(files.removals).toEqual([seen]);
    expect(files.files.has(seen)).toBe(false);
  });

  it("deletes the recording even when the operation throws", async () => {
    const { audio, files } = scratch();
    let used = "";
    await expect(
      audio.withAudio((path) => {
        used = path;
        files.files.set(path, 64_000);
        return Promise.reject(new Error("whisper failed"));
      }),
    ).rejects.toThrow("whisper failed");

    expect(files.files.has(used)).toBe(false);
    expect(files.removals).toContain(used);
  });

  it("throws if file deletion failed to remove the file", async () => {
    const { audio, files } = scratch();
    await expect(
      audio.withAudio((path) => {
        files.files.set(path, 64_000);
        files.undeletable.add(path);
        return Promise.resolve();
      }),
    ).rejects.toBeInstanceOf(AudioNotDeletedError);
  });

  it("does not report error for file that recorder never created", async () => {
    const { audio, files } = scratch();
    await audio.withAudio(() => Promise.resolve());
    expect(files.removals).toEqual([]);
  });

  it("creates directory with 0700 permissions before writing", async () => {
    const { audio, files } = scratch();
    await audio.withAudio(() => Promise.resolve());
    expect(files.directories.has("/tmp/nexus-audio")).toBe(true);
  });

  it("generates a distinct name for each recording", async () => {
    const { audio } = scratch();
    const first = await audio.withAudio((path) => Promise.resolve(path));
    const second = await audio.withAudio((path) => Promise.resolve(path));
    expect(first).not.toBe(second);
  });
});

describe("retention 'diagnostic'", () => {
  it("retains the file and notifies callback", async () => {
    const { audio, files, retained } = scratch({ retention: "diagnostic" });
    const path = await audio.withAudio((candidate) => {
      files.files.set(candidate, 64_000);
      return Promise.resolve(candidate);
    });

    expect(files.files.has(path)).toBe(true);
    expect(files.removals).toEqual([]);
    expect(retained).toEqual([path]);
  });
});

describe("purge", () => {
  it("deletes leftover files and confirms deletion", async () => {
    const { audio, files } = scratch();
    files.files.set("/tmp/nexus-audio/a.wav", 1);
    files.files.set("/tmp/nexus-audio/b.wav", 1);
    expect(await audio.purge(["a.wav", "b.wav", "absent.wav"])).toBe(2);
    expect(files.files.size).toBe(0);
  });

  it("throws if a leftover file cannot be deleted", async () => {
    const { audio, files } = scratch();
    files.files.set("/tmp/nexus-audio/a.wav", 1);
    files.undeletable.add("/tmp/nexus-audio/a.wav");
    await expect(audio.purge(["a.wav"])).rejects.toBeInstanceOf(AudioNotDeletedError);
  });
});
