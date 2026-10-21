import { describe, expect, it } from "vitest";
import { InMemoryOutboxStore, NotQueueableError, Outbox, type OutboxEntry } from "../src/outbox.js";

/**
 * Une file hors ligne est une machine à doubler les actions. Ces tests
 * l'attaquent donc par là : la clé d'idempotence, l'ordre, l'arrêt au premier
 * échec, l'expiration, et ce qu'elle refuse de garder.
 */

const MESSAGE = {
  method: "POST" as const,
  path: "/api/v1/orchestrator/messages",
  body: { message: "salut" },
};

function outbox(options: { ttlMs?: number; capacity?: number; now?: () => number } = {}) {
  const store = new InMemoryOutboxStore();
  let counter = 0;
  const queue = new Outbox({
    store,
    idempotentPaths: ["/api/v1/orchestrator/messages"],
    newId: () => {
      counter += 1;
      return `id-${String(counter)}`;
    },
    ...options,
  });
  return { queue, store };
}

const ok = () => Promise.resolve({ ok: true as const });

describe("ce qui peut attendre le réseau", () => {
  it("accepte un chemin que le serveur sait dédupliquer", async () => {
    const { queue } = outbox();
    const entry = await queue.enqueue(MESSAGE);
    expect(entry.idempotencyKey).toBeTruthy();
    expect(await queue.pending()).toHaveLength(1);
  });

  it("refuse un chemin dont la clé n'est pas honorée", async () => {
    // Si le serveur n'honore pas la clé, mettre en file **garantit** le doublon
    // au lieu de le risquer. Refuser et le dire vaut mieux.
    const { queue } = outbox();
    const verdict = queue.queueable({ method: "POST", path: "/api/v1/tasks", body: {} });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("envoi répété");
    await expect(
      queue.enqueue({ method: "POST", path: "/api/v1/tasks", body: {} }),
    ).rejects.toBeInstanceOf(NotQueueableError);
  });

  it("refuse une confirmation, même sur un chemin idempotent", () => {
    // Approuver hors ligne puis envoyer trois heures plus tard, c'est approuver
    // quelque chose qu'on n'a pas relu — et qui a peut-être changé.
    const { queue } = outbox();
    for (const path of [
      "/api/v1/confirmations/abc/respond",
      "/api/v1/agent-core/runs/abc/confirmation",
    ]) {
      expect(queue.queueable({ method: "POST", path, body: {} }).ok, path).toBe(false);
    }
  });
});

describe("la clé d'idempotence", () => {
  it("ne change pas d'une tentative à l'autre", async () => {
    const { queue } = outbox();
    await queue.enqueue(MESSAGE);

    const keys: string[] = [];
    const failing = (entry: OutboxEntry) => {
      keys.push(entry.idempotencyKey);
      return Promise.resolve({ ok: false as const, retryable: true, error: "réseau" });
    };

    await queue.flush(failing);
    await queue.flush(failing);
    await queue.flush(failing);

    // C'est tout l'intérêt : les trois tentatives portent la même clé, donc le
    // cœur reconnaît la répétition. Une clé générée à l'envoi serait inutile.
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("diffère entre deux entrées", async () => {
    const { queue } = outbox();
    const first = await queue.enqueue(MESSAGE);
    const second = await queue.enqueue(MESSAGE);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });
});

describe("envoi", () => {
  it("respecte l'ordre", async () => {
    const { queue } = outbox();
    await queue.enqueue({ ...MESSAGE, body: { message: "un" } });
    await queue.enqueue({ ...MESSAGE, body: { message: "deux" } });

    const order: unknown[] = [];
    await queue.flush((entry) => {
      order.push((entry.request.body as { message: string }).message);
      return ok();
    });
    // Deux messages envoyés à l'envers racontent une autre conversation.
    expect(order).toEqual(["un", "deux"]);
  });

  it("s'arrête au premier échec réessayable", async () => {
    const { queue } = outbox();
    await queue.enqueue({ ...MESSAGE, body: { message: "un" } });
    await queue.enqueue({ ...MESSAGE, body: { message: "deux" } });

    let calls = 0;
    const outcome = await queue.flush(() => {
      calls += 1;
      return Promise.resolve({ ok: false as const, retryable: true, error: "réseau" });
    });

    // Continuer après un échec réseau enverrait le second message d'une suite
    // dont le premier n'est pas passé.
    expect(calls).toBe(1);
    expect(outcome.stoppedBy).toBe("échec");
    expect(outcome.remaining).toHaveLength(2);
    expect(outcome.remaining[0]?.lastError).toBe("réseau");
  });

  it("écarte un refus définitif pour ne pas bloquer la file", async () => {
    const { queue } = outbox();
    await queue.enqueue({ ...MESSAGE, body: { message: "invalide" } });
    await queue.enqueue({ ...MESSAGE, body: { message: "valable" } });

    const sent: string[] = [];
    const outcome = await queue.flush((entry) => {
      const message = (entry.request.body as { message: string }).message;
      if (message === "invalide") {
        return Promise.resolve({ ok: false as const, retryable: false, error: "400" });
      }
      sent.push(message);
      return ok();
    });

    // Un refus définitif ne sera pas meilleur demain ; le garder bloquerait
    // toute la file derrière lui.
    expect(sent).toEqual(["valable"]);
    expect(outcome.remaining).toHaveLength(0);
  });

  it("n'envoie rien hors ligne", async () => {
    const { queue } = outbox();
    await queue.enqueue(MESSAGE);
    let calls = 0;
    const outcome = await queue.flush(
      () => {
        calls += 1;
        return ok();
      },
      { online: false },
    );

    // Une tentative sans réseau ne fait que consommer un essai et brouiller le
    // compte.
    expect(calls).toBe(0);
    expect(outcome.stoppedBy).toBe("hors-ligne");
    expect(outcome.remaining).toHaveLength(1);
  });

  it("compte les tentatives", async () => {
    const { queue } = outbox();
    await queue.enqueue(MESSAGE);
    const fail = () => Promise.resolve({ ok: false as const, retryable: true, error: "réseau" });
    await queue.flush(fail);
    const outcome = await queue.flush(fail);
    expect(outcome.remaining[0]?.attempts).toBe(2);
  });
});

describe("expiration", () => {
  it("n'envoie pas une intention dont le contexte a disparu", async () => {
    let instant = 1_000;
    const { queue } = outbox({ now: () => instant, ttlMs: 60_000 });
    await queue.enqueue(MESSAGE);

    instant += 60_001;
    let calls = 0;
    const outcome = await queue.flush(() => {
      calls += 1;
      return ok();
    });

    // « Réponds à ce mail » mis en file mardi n'a aucun sens vendredi, et
    // l'exécuter serait pire que de l'avoir perdu.
    expect(calls).toBe(0);
    expect(outcome.expired).toHaveLength(1);
    expect(outcome.remaining).toHaveLength(0);
  });

  it("disparaît de la file en attente avant même d'être envoyée", async () => {
    let instant = 1_000;
    const { queue } = outbox({ now: () => instant, ttlMs: 60_000 });
    await queue.enqueue(MESSAGE);
    expect(await queue.pending()).toHaveLength(1);
    instant += 60_001;
    expect(await queue.pending()).toHaveLength(0);
  });
});

describe("capacité", () => {
  it("écarte les plus anciennes quand la file est pleine", async () => {
    const { queue } = outbox({ capacity: 2 });
    await queue.enqueue({ ...MESSAGE, body: { message: "un" } });
    await queue.enqueue({ ...MESSAGE, body: { message: "deux" } });
    await queue.enqueue({ ...MESSAGE, body: { message: "trois" } });

    const pending = await queue.pending();
    // Une file pleine doit perdre ce qui a le moins de chances d'avoir encore
    // du sens.
    expect(pending.map((entry) => (entry.request.body as { message: string }).message)).toEqual([
      "deux",
      "trois",
    ]);
  });
});

describe("déconnexion", () => {
  it("vide la file : elle appartient à une session", async () => {
    const { queue } = outbox();
    await queue.enqueue(MESSAGE);
    await queue.clear();
    expect(await queue.pending()).toHaveLength(0);
  });
});
