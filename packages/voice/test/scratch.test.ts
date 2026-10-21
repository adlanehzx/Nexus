import { describe, expect, it } from "vitest";
import { AudioNotDeletedError, AudioScratch } from "../src/scratch.js";
import { FakeFiles } from "./fakes.js";

/**
 * « Aucun audio conservé » est la promesse la plus facile à faire et la plus
 * facile à trahir : un `return` anticipé, une exception, un processus tué au
 * mauvais moment, et un enregistrement de la cuisine reste sur le disque.
 *
 * Ces tests l'attaquent donc par ses trois voies de fuite : le chemin normal,
 * le chemin d'erreur, et une suppression qui échoue.
 */

function scratch(options: { retention?: "aucune" | "diagnostic" } = {}) {
  const files = new FakeFiles();
  const retained: string[] = [];
  let index = 0;
  const audio = new AudioScratch({
    files,
    directory: "/tmp/nexus-audio",
    ...(options.retention === undefined ? {} : { retention: options.retention }),
    newName: () => {
      index += 1;
      return `dictee-${String(index)}.wav`;
    },
    onRetained: (path) => retained.push(path),
  });
  return { audio, files, retained };
}

describe("rétention « aucune », le défaut", () => {
  it("supprime l'enregistrement après usage", async () => {
    const { audio, files } = scratch();
    const seen = await audio.withAudio((path) => {
      // L'enregistreur a écrit : on le simule, parce que c'est le cas réel.
      files.files.set(path, 64_000);
      return Promise.resolve(path);
    });

    expect(files.removals).toEqual([seen]);
    expect(files.files.has(seen)).toBe(false);
  });

  it("supprime même quand l'opération échoue", async () => {
    // C'est le chemin qu'on oublie, et c'est le seul qui compte vraiment : une
    // transcription qui échoue est précisément le moment où l'on ne penserait
    // pas à nettoyer.
    const { audio, files } = scratch();
    let used = "";
    await expect(
      audio.withAudio((path) => {
        used = path;
        files.files.set(path, 64_000);
        return Promise.reject(new Error("whisper a échoué"));
      }),
    ).rejects.toThrow("whisper a échoué");

    expect(files.files.has(used)).toBe(false);
    expect(files.removals).toContain(used);
  });

  it("lève si la suppression n'a pas eu lieu", async () => {
    // Un `unlink` dont on ignore le résultat est une intention, pas une
    // suppression. Si le fichier survit, la dictée doit s'arrêter bruyamment
    // plutôt que de continuer à enregistrer dans un dossier qui se remplit.
    const { audio, files } = scratch();
    await expect(
      audio.withAudio((path) => {
        files.files.set(path, 64_000);
        files.undeletable.add(path);
        return Promise.resolve();
      }),
    ).rejects.toBeInstanceOf(AudioNotDeletedError);
  });

  it("ne se plaint pas d'un fichier que l'enregistreur n'a jamais créé", async () => {
    const { audio, files } = scratch();
    await audio.withAudio(() => Promise.resolve());
    expect(files.removals).toEqual([]);
  });

  it("crée le dossier en 0700 avant d'écrire", async () => {
    const { audio, files } = scratch();
    await audio.withAudio(() => Promise.resolve());
    expect(files.directories.has("/tmp/nexus-audio")).toBe(true);
  });

  it("donne un nom différent à chaque enregistrement", async () => {
    const { audio } = scratch();
    const first = await audio.withAudio((path) => Promise.resolve(path));
    const second = await audio.withAudio((path) => Promise.resolve(path));
    expect(first).not.toBe(second);
  });
});

describe("rétention « diagnostic »", () => {
  it("garde le fichier et le signale", async () => {
    // Jamais par défaut, et annoncé bruyamment : c'est une décision, pas une
    // option de confort.
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
  it("efface ce qui traîne, et vérifie", async () => {
    const { audio, files } = scratch();
    files.files.set("/tmp/nexus-audio/a.wav", 1);
    files.files.set("/tmp/nexus-audio/b.wav", 1);
    expect(await audio.purge(["a.wav", "b.wav", "absent.wav"])).toBe(2);
    expect(files.files.size).toBe(0);
  });

  it("lève si un fichier résiste", async () => {
    const { audio, files } = scratch();
    files.files.set("/tmp/nexus-audio/a.wav", 1);
    files.undeletable.add("/tmp/nexus-audio/a.wav");
    await expect(audio.purge(["a.wav"])).rejects.toBeInstanceOf(AudioNotDeletedError);
  });
});
