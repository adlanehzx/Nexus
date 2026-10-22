import { readFile } from "node:fs/promises";
import { createPrivateKey, sign as signEd25519 } from "node:crypto";
import type { CredentialSigner } from "@nexus/worker-core";
import { WorkerConfigurationError } from "../errors.js";

/**
 * Challenge signature.
 *
 * Device private key never leaves the machine. The worker signs a single-use nonce.
 */

export type { CredentialSigner } from "@nexus/worker-core";

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
      throw new WorkerConfigurationError([
        `unreadable private key (${cause instanceof Error ? cause.message : "unknown error"})`,
      ]);
    }

    try {
      const key = createPrivateKey(pem);
      return signEd25519(null, Buffer.from(nonce, "utf8"), key).toString("base64");
    } catch {
      throw new WorkerConfigurationError(["private key is not an Ed25519 key in PEM format"]);
    }
  }
}

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
