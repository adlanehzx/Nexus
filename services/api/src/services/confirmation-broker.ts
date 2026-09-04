import type { ConfirmationGate } from "@nexus/devices";
import type { ConfirmationService } from "@nexus/tools";

/**
 * Le pont entre le coordinateur de tâches et une décision humaine.
 *
 * `TaskCoordinator` attend un `ConfirmationGate` : il pose une question et
 * attend un verdict. `ConfirmationService` sait créer et trancher une demande,
 * mais **ne bloque jamais** — c'est justement sa qualité, un run agent peut
 * attendre dix minutes sans immobiliser de processus.
 *
 * Ce courtier réconcilie les deux : il crée la demande, garde la promesse
 * ouverte, et la résout quand l'utilisateur répond depuis **n'importe lequel de
 * ses appareils**. C'est ce dernier point qui compte : une confirmation demandée
 * pendant qu'on est sur l'iPhone peut être approuvée depuis le portable, parce
 * que la demande vit au centre et non dans le client qui l'a affichée.
 *
 * Une demande sans réponse expire. L'expiration vaut **refus** : le silence ne
 * doit jamais valoir accord pour une action qui touche les fichiers ou l'argent
 * de quelqu'un.
 */

type Decision = "approved" | "rejected" | "expired";

interface Pending {
  resolve: (decision: Decision) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  userId: string;
}

export interface ConfirmationBrokerOptions {
  confirmations: ConfirmationService;
  now?: () => Date;
  /** Injectables pour éprouver l'expiration sans attendre réellement. */
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class ConfirmationBroker implements ConfirmationGate {
  readonly #confirmations: ConfirmationService;
  readonly #now: () => Date;
  readonly #setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  readonly #pending = new Map<string, Pending>();

  constructor(options: ConfirmationBrokerOptions) {
    this.#confirmations = options.confirmations;
    this.#now = options.now ?? (() => new Date());
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle);
      });
  }

  /** Demandes en attente pour un utilisateur — diagnostic et tests. */
  pendingIds(userId: string): string[] {
    return [...this.#pending.entries()]
      .filter(([, pending]) => pending.userId === userId)
      .map(([id]) => id);
  }

  /**
   * Demande une confirmation et attend la réponse.
   *
   * L'identifiant est celui que le coordinateur a déjà émis dans son événement
   * `confirmation.required` : les clients l'ont reçu, et c'est celui qu'ils
   * renverront. Créer un second identifiant ici les désynchroniserait.
   */
  request(input: Parameters<ConfirmationGate["request"]>[0]): Promise<Decision> {
    const ttlMs = Math.max(0, input.expiresAt.getTime() - this.#now().getTime());

    return new Promise<Decision>((resolve) => {
      let settled = false;
      const settle = (decision: Decision) => {
        if (settled) return;
        settled = true;

        const pending = this.#pending.get(input.confirmationId);
        if (pending?.timer !== undefined) this.#clearTimer(pending.timer);
        this.#pending.delete(input.confirmationId);

        resolve(decision);
      };

      // Le silence vaut refus, jamais accord.
      const timer = this.#setTimer(() => {
        settle("expired");
      }, ttlMs);

      this.#pending.set(input.confirmationId, {
        resolve: settle,
        timer,
        userId: input.userId,
      });
    });
  }

  /**
   * Enregistre la réponse de l'utilisateur.
   *
   * Retourne `false` si aucune demande n'attend cet identifiant : cas normal
   * quand deux clients répondent presque en même temps, ou quand la demande a
   * expiré entre l'affichage et le geste. Ce n'est pas une erreur, et la traiter
   * comme telle ferait afficher un message d'échec au second client alors que
   * tout s'est bien passé.
   */
  respond(confirmationId: string, decision: "approved" | "rejected", userId: string): boolean {
    const pending = this.#pending.get(confirmationId);

    // **La demande appartient à quelqu'un.** Le courtier connaissait déjà son
    // propriétaire ; ne pas le vérifier laissait n'importe quel compte
    // authentifié approuver l'action de quelqu'un d'autre, à condition d'en
    // connaître l'identifiant — et cet identifiant voyage jusqu'à tous les
    // clients de la victime.
    //
    // Le refus est indiscernable d'une demande absente : distinguer les deux
    // permettrait de sonder l'existence des confirmations d'autrui.
    if (pending?.userId !== userId) return false;

    pending.resolve(decision);
    return true;
  }

  /**
   * Enregistre la décision **et** la consigne dans le service de confirmation.
   *
   * Les deux enregistrements sont distincts : le service tient l'historique
   * durable — qui a approuvé quoi, et quand — pendant que ce courtier ne
   * s'occupe que des promesses en vol.
   */
  async respondAndRecord(
    confirmationId: string,
    decision: "approved" | "rejected",
    userId: string,
  ): Promise<boolean> {
    const known = await this.#confirmations.get(confirmationId);

    // Propriété vérifiée **avant** d'écrire la trace : consigner la décision
    // d'un intrus dans l'historique de la victime salirait l'audit même si
    // l'action n'a pas lieu.
    if (known !== undefined && known.userId !== userId) return false;

    // Une demande émise par le coordinateur ne vit d'abord que dans le
    // courtier ; c'est lui qui tranche la propriété dans ce cas, et il la
    // connaît.
    if (known === undefined && this.#pending.get(confirmationId)?.userId !== userId) return false;

    if (known !== undefined) await this.#confirmations.resolve(confirmationId, decision);

    return this.respond(confirmationId, decision, userId);
  }

  /** Refuse tout ce qui attend — arrêt du serveur, ou révocation. */
  rejectAll(): number {
    const count = this.#pending.size;
    for (const [id] of [...this.#pending]) {
      this.#pending.get(id)?.resolve("rejected");
    }
    return count;
  }
}
