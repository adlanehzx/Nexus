/**
 * `Buffer`, réduit à ce que NEXUS en fait sur Android.
 *
 * `uuidv7()` de `@nexus/shared` appelle `Buffer.from(octets).toString("hex")`.
 * C'est le seul usage sur le chemin du worker Android — vérifié en suivant les
 * imports depuis `src/main.ts`.
 *
 * Plutôt que d'embarquer l'implémentation complète de `buffer` (une
 * dépendance de plus, quarante kilo-octets, et une surface qu'il faudrait
 * suivre), on fournit exactement les deux fonctions utilisées. Ce qui manque
 * lève, et se verra au premier appel.
 */

function toHex(octets) {
  let texte = "";
  for (let index = 0; index < octets.length; index += 1) {
    texte += octets[index].toString(16).padStart(2, "0");
  }
  return texte;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(octets) {
  let sortie = "";

  for (let index = 0; index < octets.length; index += 3) {
    const a = octets[index];
    const b = octets[index + 1];
    const c = octets[index + 2];

    sortie += ALPHABET[a >> 2];
    sortie += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    sortie += b === undefined ? "=" : ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    sortie += c === undefined ? "=" : ALPHABET[c & 0x3f];
  }

  return sortie;
}

class NexusBuffer extends Uint8Array {
  toString(encodage) {
    if (encodage === "hex") return toHex(this);
    if (encodage === "base64") return toBase64(this);
    if (encodage === "utf8" || encodage === undefined) {
      return String.fromCharCode.apply(null, Array.from(this));
    }
    throw new Error(`Buffer.toString : encodage « ${String(encodage)} » non pris en charge`);
  }
}

const Buffer = {
  from(source, encodage) {
    if (typeof source === "string") {
      if (encodage !== undefined && encodage !== "utf8") {
        throw new Error(`Buffer.from : encodage « ${encodage} » non pris en charge`);
      }
      const octets = new NexusBuffer(source.length);
      for (let index = 0; index < source.length; index += 1) {
        octets[index] = source.charCodeAt(index) & 0xff;
      }
      return octets;
    }

    const vue = new NexusBuffer(source.length ?? source.byteLength);
    vue.set(source);
    return vue;
  },

  alloc(taille) {
    return new NexusBuffer(taille);
  },

  isBuffer(valeur) {
    return valeur instanceof NexusBuffer;
  },
};

module.exports = { Buffer, NexusBuffer };
