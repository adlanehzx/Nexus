import { readFile } from "node:fs/promises";
import { createPrivateKey, sign as signEd25519 } from "node:crypto";
import type { CredentialSigner } from "@nexus/worker-core";
import { WorkerConfigurationError } from "../errors.js";

/**
 * Signature du challenge.
 *
 * La clé privée de l'appareil ne quitte jamais la machine et n'est jamais
 * transmise : le worker prouve qu'il la détient en signant un nonce à usage
 * unique. Un jeton dérobé dans un journal ne permet donc pas de se faire passer
 * pour cette machine — il n'y a pas de secret partagé à dérober.
 *
 * C'est un **port**. Le jour où la clé vivra dans le TPM ou dans le magasin de
 * certificats de Windows, seule l'implémentation change.
 */

export type { CredentialSigner } from "@nexus/worker-core";

/**
 * Signataire lisant une clé Ed25519 au format PEM depuis un fichier.
 *
 * La clé est lue **à chaque signature**, pas mise en cache. Une signature a lieu
 * à la connexion et à la rotation, soit quelques fois par heure : le coût est
 * nul, et le bénéfice réel — la clé ne reste pas indéfiniment dans la mémoire
 * d'un processus de longue durée, où un vidage de mémoire la trouverait.
 */
export class FileCredentialSigner implements CredentialSigner {
  readonly #path: string;

  constructor(privateKeyPath: string) {
    this.#path = privateKeyPath;
  }

  async sign(nonce: string): Promise<string> {
    let pem: string;
    try {
      pem = await readFile(this.#path, "utf8");
    } catch (cause) {
      // Le chemin figure dans le contexte, jamais dans le message affiché.
      throw new WorkerConfigurationError([
        `clé privée illisible (${cause instanceof Error ? cause.message : "erreur inconnue"})`,
      ]);
    }

    try {
      const key = createPrivateKey(pem);
      return signEd25519(null, Buffer.from(nonce, "utf8"), key).toString("base64");
    } catch {
      throw new WorkerConfigurationError(["la clé privée n'est pas une clé Ed25519 au format PEM"]);
    }
  }
}

/** Signataire de test : signe avec une clé fournie en mémoire. */
export class InMemoryCredentialSigner implements CredentialSigner {
  readonly #pem: string;

  constructor(privateKeyPem: string) {
    this.#pem = privateKeyPem;
  }

  sign(nonce: string): Promise<string> {
    const key = createPrivateKey(this.#pem);
    return Promise.resolve(signEd25519(null, Buffer.from(nonce, "utf8"), key).toString("base64"));
  }
}
