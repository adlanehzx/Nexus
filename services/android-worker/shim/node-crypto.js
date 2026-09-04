/**
 * `node:crypto`, pour React Native.
 *
 * ## Pourquoi ce fichier existe
 *
 * `@nexus/shared` — partagé par le cœur, le worker Windows et celui-ci —
 * construit ses identifiants avec `uuidv7()`, qui appelle `randomFillSync` de
 * `node:crypto`. Le moteur JavaScript d'Android n'a ni ce module, ni
 * `crypto.getRandomValues`. Sans ce fichier, le paquet ne se charge pas.
 *
 * La règle du travail en cours interdit de modifier `packages/shared`. C'est
 * d'ailleurs le bon choix : ce n'est pas au code partagé de connaître Android.
 * On traduit donc côté Android, ce qui est exactement le rôle d'une couche
 * d'adaptation.
 *
 * ## L'aléa est réel
 *
 * `secureRandomBase64` s'adosse à `java.security.SecureRandom`. **Pas de
 * `Math.random`** : sa suite se prédit à partir de quelques observations, et
 * ces octets deviennent des identifiants de requête qui traversent le
 * protocole. Un identifiant devinable permet de fabriquer une trame qui semble
 * répondre à une demande en cours.
 *
 * ## Ce qui n'est pas implémenté
 *
 * Tout le reste — chiffrement, dérivation, `createHash`. Ces fonctions lèvent
 * plutôt que de rendre un résultat approximatif : sur un appareil qui signe des
 * défis, une primitive cryptographique à moitié juste est pire qu'absente.
 */
const { NativeModules } = require("react-native");

const OCTETS_PAR_APPEL = 256;

let reserve = new Uint8Array(0);
let curseur = 0;

/** Recharge la réserve depuis le générateur d'Android. */
function remplirReserve(minimum) {
  const natif = NativeModules.NexusWorker;
  if (natif === undefined || natif === null) {
    throw new Error(
      "NexusWorker : module natif absent, aucune source d'aléa cryptographique disponible",
    );
  }

  const taille = Math.max(minimum, OCTETS_PAR_APPEL);
  const base64 = natif.secureRandomBase64(taille);
  reserve = decodeBase64(base64);
  curseur = 0;
}

/**
 * Décode du base64 sans `Buffer` ni `atob`.
 *
 * Hermes fournit `atob` depuis peu, mais pas sur toutes les versions ; vingt
 * lignes ici valent mieux qu'une dépendance de plus dans une application qui
 * détient un service d'accessibilité.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(texte) {
  const propre = texte.replace(/[^A-Za-z0-9+/]/g, "");
  const sortie = new Uint8Array(Math.floor((propre.length * 3) / 4));

  let ecrit = 0;
  let tampon = 0;
  let bits = 0;

  for (let index = 0; index < propre.length; index += 1) {
    tampon = (tampon << 6) | ALPHABET.indexOf(propre[index]);
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      sortie[ecrit++] = (tampon >> bits) & 0xff;
    }
  }

  return sortie.subarray(0, ecrit);
}

/**
 * Remplit une vue d'octets avec de l'aléa cryptographique.
 *
 * Même signature que Node : la vue est remplie sur place et renvoyée.
 */
function randomFillSync(vue) {
  const octets = new Uint8Array(vue.buffer, vue.byteOffset, vue.byteLength);

  for (let index = 0; index < octets.length; index += 1) {
    if (curseur >= reserve.length) remplirReserve(octets.length - index);
    octets[index] = reserve[curseur++];
  }

  return vue;
}

/** Alias de la norme du navigateur, même source. */
function getRandomValues(vue) {
  return randomFillSync(vue);
}

/** UUID v4, conforme à la RFC 9562. */
function randomUUID() {
  const octets = new Uint8Array(16);
  randomFillSync(octets);

  octets[6] = (octets[6] & 0x0f) | 0x40;
  octets[8] = (octets[8] & 0x3f) | 0x80;

  const hex = [];
  for (let index = 0; index < 16; index += 1) {
    hex.push(octets[index].toString(16).padStart(2, "0"));
  }

  const texte = hex.join("");
  return [
    texte.slice(0, 8),
    texte.slice(8, 12),
    texte.slice(12, 16),
    texte.slice(16, 20),
    texte.slice(20, 32),
  ].join("-");
}

/**
 * Tout ce qui n'est pas implémenté échoue bruyamment.
 *
 * Un `createHash` qui renverrait n'importe quoi produirait des signatures
 * fausses sans le dire. On préfère l'arrêt net.
 */
function nonImplemente(nom) {
  return () => {
    throw new Error(
      `node:crypto.${nom} n'est pas disponible sur Android. ` +
        "La signature de l'appareil passe par le magasin de cles, pas par cette fonction.",
    );
  };
}

module.exports = {
  randomFillSync,
  randomUUID,
  getRandomValues,
  createHash: nonImplemente("createHash"),
  createHmac: nonImplemente("createHmac"),
  createSign: nonImplemente("createSign"),
  createVerify: nonImplemente("createVerify"),
  timingSafeEqual: nonImplemente("timingSafeEqual"),
  default: { randomFillSync, randomUUID, getRandomValues },
};
