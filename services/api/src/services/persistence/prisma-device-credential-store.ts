import { createPublicKey } from "node:crypto";
import type { PrismaClient } from "@nexus/database";
import { uuidv7 } from "@nexus/shared";
import type { DeviceCredentialStore } from "@nexus/devices";

/**
 * Clés publiques d'appareils sur PostgreSQL.
 *
 * ## Pourquoi ce magasin existe
 *
 * La table `device_credentials` était dans le schéma depuis le début, et
 * personne ne l'écrivait : la production montait `InMemoryCredentialProvider`.
 * La conséquence n'était pas une absence de fonctionnalité mais une **panne
 * silencieuse** : au redémarrage de l'API, toutes les clés disparaissaient. Un
 * worker se reconnectait, signait son challenge, et se faisait refuser parce
 * qu'il n'y avait plus rien pour vérifier sa signature. Rien ne nommait la
 * cause, et le seul remède était de réenregistrer chaque appareil.
 *
 * C'est exactement la classe de défaut que `persistence.pg.test.ts` décrit dans
 * son propre préambule : ce qui n'est vérifié que contre une doublure n'est pas
 * vérifié.
 *
 * ## Révoquer n'est pas supprimer
 *
 * Un retrait écrit `revokedAt` au lieu d'effacer la ligne. La clé publique
 * n'est pas un secret — c'est la moitié publiable — et conserver la trace
 * répond à une question qu'on se pose après un incident : *quelle* clé était
 * enregistrée, et depuis quand. La lecture ignore les lignes révoquées, donc
 * l'effet est le même pour l'authentification.
 */
export class PrismaDeviceCredentialStore implements DeviceCredentialStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async publicKeyFor(deviceId: string): Promise<string | undefined> {
    const row = await this.#prisma.deviceCredential.findFirst({
      where: {
        deviceId,
        revokedAt: null,
        kind: { in: ["ED25519_PUBLIC_KEY", "ECDSA_P256_PUBLIC_KEY"] },
        // Une clé expirée ne vérifie plus rien. `null` veut dire « sans
        // échéance », ce qui est le cas courant d'une clé matérielle.
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      // La plus récente gagne : c'est ce qui rend une rotation effective sans
      // exiger que l'ancienne ait été retirée d'abord.
      orderBy: { createdAt: "desc" },
    });
    return row === null ? undefined : row.material;
  }

  /**
   * Enregistre une clé, en remplaçant celle qui servait.
   *
   * Le remplacement est une **rotation** : l'ancienne ligne reçoit `rotatedAt`
   * et `revokedAt` plutôt que de disparaître. Deux clés actives pour un même
   * appareil seraient une ambiguïté — laquelle doit vérifier ? — et la lecture
   * ci-dessus trancherait par la date, ce qui est un comportement trop
   * implicite pour une décision d'authentification.
   */
  async set(deviceId: string, publicKeyPem: string): Promise<void> {
    const kind = credentialKind(publicKeyPem);
    const now = new Date();
    await this.#prisma.$transaction(async (tx) => {
      await tx.deviceCredential.updateMany({
        where: { deviceId, revokedAt: null },
        data: { rotatedAt: now, revokedAt: now },
      });
      await tx.deviceCredential.create({
        data: { id: uuidv7(), deviceId, kind, material: publicKeyPem, createdAt: now },
      });
    });
  }

  async revoke(deviceId: string): Promise<void> {
    const now = new Date();
    await this.#prisma.deviceCredential.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}

/**
 * Détermine l'algorithme **à partir de la clé**, et non de ce qu'on nous dit.
 *
 * Android ne sait pas conserver de clé Ed25519 dans son magasin matériel et
 * fournit donc de l'ECDSA P-256 ; un poste fixe fournit de l'Ed25519. Laisser
 * l'appelant déclarer son algorithme ouvrirait un désaccord entre l'étiquette
 * et le contenu, et c'est l'étiquette qui choisirait le vérificateur.
 */
function credentialKind(publicKeyPem: string): "ED25519_PUBLIC_KEY" | "ECDSA_P256_PUBLIC_KEY" {
  let type: string;
  try {
    type = createPublicKey(publicKeyPem).asymmetricKeyType ?? "";
  } catch (error) {
    throw new Error("clé publique illisible : ce n'est pas un PEM valide", { cause: error });
  }
  if (type === "ed25519") return "ED25519_PUBLIC_KEY";
  if (type === "ec") return "ECDSA_P256_PUBLIC_KEY";
  throw new Error(`algorithme de clé non pris en charge : ${type}`);
}
