import { PolicyViolationError } from "@nexus/worker-core";
import type { ScrollDirection, UiSelector } from "../ports.js";

/**
 * Politique d'automatisation d'interface.
 *
 * C'est la politique la plus délicate du worker, parce qu'un clic est
 * irréversible et qu'on ne sait jamais tout à fait sur quoi on clique. Trois
 * décisions la gouvernent :
 *
 *  1. **Les coordonnées sont un dernier recours, désactivé par défaut.** Cliquer
 *     en (540, 1200) revient à toucher ce qui s'y trouve — un bouton « Payer »
 *     si l'écran a changé entre-temps. Les sélecteurs sémantiques (identifiant
 *     de vue, texte, description) désignent un élément, pas un endroit.
 *  2. **Un clic exige un élément réellement cliquable.** Le service
 *     d'accessibilité sait le dire ; ne pas le vérifier reviendrait à envoyer
 *     l'événement au hasard dans la hiérarchie.
 *  3. **Le texte saisi ne sort jamais.** Ni journal, ni événement, ni résultat.
 *     `android.ui.input` est le chemin normal d'un mot de passe.
 */

const MAX_SELECTOR_LENGTH = 256;
const MAX_INPUT_LENGTH = 4_096;
const MAX_SCROLL_AMOUNT = 20;

export interface UiPolicyOptions {
  /**
   * Autorise les clics par coordonnées.
   *
   * Faux par défaut. À n'activer que si une application refuse obstinément de
   * fournir des identifiants de vue, et en connaissance de cause.
   */
  allowCoordinateClicks?: boolean;
  /** Bornes de l'écran, pour rejeter une coordonnée hors dalle. */
  screenBounds?: { width: number; height: number };
  maxInputLength?: number;
  maxScrollAmount?: number;
}

export class UiPolicy {
  readonly #allowCoordinates: boolean;
  readonly #bounds: { width: number; height: number } | undefined;
  readonly #maxInput: number;
  readonly #maxScroll: number;

  constructor(options: UiPolicyOptions = {}) {
    this.#allowCoordinates = options.allowCoordinateClicks ?? false;
    this.#bounds = options.screenBounds;
    this.#maxInput = options.maxInputLength ?? MAX_INPUT_LENGTH;
    this.#maxScroll = options.maxScrollAmount ?? MAX_SCROLL_AMOUNT;
  }

  get allowsCoordinates(): boolean {
    return this.#allowCoordinates;
  }

  /**
   * Valide un sélecteur.
   *
   * @throws {PolicyViolationError} sur une valeur vide, trop longue, ou sur des
   *   coordonnées non autorisées ou hors écran.
   */
  assertSelectorAllowed(selector: UiSelector): UiSelector {
    if (selector.kind === "coordinates") {
      if (!this.#allowCoordinates) {
        throw new PolicyViolationError({
          rule: "ui.coordinatesDisabled",
          message: "Clic par coordonnées désactivé",
          userMessage:
            "Les clics par coordonnées sont désactivés sur cet appareil : ils touchent un " +
            "endroit de l'écran, pas un élément identifié.",
        });
      }

      if (!Number.isFinite(selector.x) || !Number.isFinite(selector.y)) {
        throw new PolicyViolationError({
          rule: "ui.coordinatesInvalid",
          message: "Coordonnées non numériques",
        });
      }
      if (selector.x < 0 || selector.y < 0) {
        throw new PolicyViolationError({
          rule: "ui.coordinatesNegative",
          message: "Coordonnées négatives",
        });
      }
      if (
        this.#bounds !== undefined &&
        (selector.x > this.#bounds.width || selector.y > this.#bounds.height)
      ) {
        throw new PolicyViolationError({
          rule: "ui.coordinatesOutOfBounds",
          message: "Coordonnées hors de l'écran",
          userMessage: "Le point visé est en dehors de l'écran.",
        });
      }

      return selector;
    }

    const value = selector.value.trim();
    if (value.length === 0) {
      throw new PolicyViolationError({
        rule: "ui.selectorEmpty",
        message: `Sélecteur ${selector.kind} vide`,
      });
    }
    if (value.length > MAX_SELECTOR_LENGTH) {
      throw new PolicyViolationError({
        rule: "ui.selectorTooLong",
        message: `Sélecteur ${selector.kind} trop long`,
      });
    }

    return { kind: selector.kind, value };
  }

  /**
   * Valide un texte à saisir.
   *
   * Renvoie le texte tel quel : il doit atteindre le champ intact. Ce qui est
   * borné, c'est sa longueur — une saisie d'un mégaoctet dans un champ de
   * recherche n'a aucun usage légitime et fige l'interface.
   *
   * **Le texte n'apparaît nulle part ailleurs.** Ni ici, ni dans l'erreur.
   */
  assertTextAllowed(text: string): string {
    if (text.length === 0) {
      throw new PolicyViolationError({
        rule: "ui.textEmpty",
        message: "Texte de saisie vide",
        userMessage: "Aucun texte à saisir n'a été fourni.",
      });
    }
    if (text.length > this.#maxInput) {
      throw new PolicyViolationError({
        rule: "ui.textTooLong",
        // La longueur seule : le contenu ne doit pas atteindre le journal.
        message: `Texte de saisie trop long (${String(text.length)} caractères)`,
        userMessage: "Le texte à saisir dépasse la longueur autorisée.",
        context: { length: text.length },
      });
    }
    if (text.includes("\0")) {
      throw new PolicyViolationError({
        rule: "ui.textNul",
        message: "Texte de saisie contenant un caractère nul",
      });
    }

    return text;
  }

  /** Valide une direction et une amplitude de défilement. */
  assertScrollAllowed(
    direction: ScrollDirection,
    amount: number,
  ): { direction: ScrollDirection; amount: number } {
    if (!Number.isInteger(amount) || amount < 1) {
      throw new PolicyViolationError({
        rule: "ui.scrollAmount",
        message: `Amplitude de défilement invalide : ${String(amount)}`,
        userMessage: "L'amplitude de défilement doit être un entier positif.",
      });
    }
    if (amount > this.#maxScroll) {
      throw new PolicyViolationError({
        rule: "ui.scrollTooFar",
        message: `Amplitude de défilement excessive : ${String(amount)}`,
        userMessage: `Le défilement est limité à ${String(this.#maxScroll)} gestes par opération.`,
        context: { amount, max: this.#maxScroll },
      });
    }

    return { direction, amount };
  }

  /**
   * Vérifie qu'un nœud accepte réellement l'action demandée.
   *
   * Sans cela, on enverrait un clic à un élément qui n'en attend pas, et le
   * système le propagerait au parent — donc à un élément qu'on n'a pas choisi.
   */
  assertNodeAccepts(
    node: { clickable: boolean; editable: boolean },
    action: "click" | "input",
  ): void {
    if (action === "click" && !node.clickable) {
      throw new PolicyViolationError({
        rule: "ui.nodeNotClickable",
        message: "L'élément visé n'est pas cliquable",
        userMessage: "L'élément visé n'accepte pas de clic.",
      });
    }
    if (action === "input" && !node.editable) {
      throw new PolicyViolationError({
        rule: "ui.nodeNotEditable",
        message: "L'élément visé n'est pas un champ de saisie",
        userMessage: "L'élément visé n'est pas un champ de saisie.",
      });
    }
  }
}
