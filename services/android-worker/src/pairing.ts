import type { NexusNative } from "./bridge/native-bridge.js";

/**
 * Appairage de l'appareil.
 *
 * ## Le problème que ça résout
 *
 * La clé privée du téléphone **naît dans le magasin de clés d'Android et n'en
 * sort jamais**. C'est la propriété qui rend ce worker sûr : même en obtenant
 * les fichiers de l'application, on n'obtient pas de quoi se faire passer pour
 * lui. Mais elle a une conséquence : il n'existe aucun moyen de « copier la clé
 * vers le cœur ». Le cœur doit recevoir la **clé publique**, et quelqu'un doit
 * la lui porter.
 *
 * Ce module rend cette moitié publiable lisible, pour que l'écran de gestion
 * puisse l'afficher et que la personne qui possède le téléphone la dépose dans
 * le registre du cœur.
 *
 * ## Pourquoi ça ne s'automatise pas ici
 *
 * Un appairage automatique demanderait au téléphone de s'annoncer au cœur avant
 * d'être authentifié — c'est-à-dire de créer un appareil sans preuve. Le
 * registre exige au contraire qu'un appareil soit inscrit puis approuvé par
 * l'utilisateur avant que sa première session s'ouvre. Le geste manuel *est* la
 * preuve, et l'automatiser reviendrait à supprimer le contrôle.
 *
 * ## Ce qui n'est pas ici
 *
 * La clé privée. Elle n'est pas lue, pas exportée, pas journalisée — il n'existe
 * aucune méthode pour cela dans tout le worker, et c'est vérifié par un test.
 */

export interface PairingIdentity {
  /** Identifiant attribué par le cœur. Public : il n'authentifie rien. */
  deviceId: string;
  /** Alias dans le magasin de clés. Une référence, jamais la clé. */
  keyAlias: string;
  /**
   * Clé publique de l'appareil, au format PEM.
   *
   * À déposer dans le registre du cœur. Une clé publique se publie : elle ne
   * signe rien, elle vérifie.
   */
  publicKeyPem: string;
}

/**
 * Lit l'identité publiable de l'appareil.
 *
 * La clé est **créée à la première lecture** si elle n'existe pas : le premier
 * démarrage produit donc une identité utilisable, sans étape séparée.
 */
export async function readPairingIdentity(
  native: NexusNative,
  input: { deviceId: string; keyAlias: string },
): Promise<PairingIdentity> {
  const publicKeyPem = await native.devicePublicKeyPem(input.keyAlias);

  return {
    deviceId: input.deviceId,
    keyAlias: input.keyAlias,
    publicKeyPem: publicKeyPem.trim(),
  };
}

/**
 * Forme courte d'une clé publique, pour comparer d'un coup d'œil.
 *
 * Sert à vérifier que la clé déposée dans le cœur est bien celle du téléphone
 * qu'on a en main. Ce n'est pas une empreinte cryptographique — juste les
 * caractères de tête et de queue du corps encodé.
 */
export function shortKey(publicKeyPem: string): string {
  const corps = publicKeyPem
    .replace(/-----[A-Z ]+-----/g, "")
    .replace(/\s+/g, "")
    .trim();

  if (corps.length <= 20) return corps;
  return `${corps.slice(0, 10)}…${corps.slice(-10)}`;
}
