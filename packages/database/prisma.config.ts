import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Configuration Prisma 7.
 *
 * Depuis la v7, l'URL de connexion ne vit plus dans `schema.prisma` : les
 * commandes de migration la lisent ici, et le client applicatif la reçoit via un
 * driver adapter (cf. `src/client.ts`). Le schéma ne décrit plus que la forme des
 * données — la connexion est une affaire de configuration, pas de modèle.
 *
 * Prisma 7 ne charge plus automatiquement les fichiers .env : on le fait
 * explicitement, depuis la racine du monorepo, pour que `pnpm db:migrate`
 * fonctionne quel que soit le répertoire courant.
 */
const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [resolve(here, ".env"), resolve(here, "../../.env")]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // L'URL n'est renseignée que si l'environnement la fournit.
  //
  // `prisma generate` n'a besoin d'aucune connexion : exiger DATABASE_URL le
  // ferait échouer dans un build Docker, où la base n'existe pas encore. Les
  // commandes qui en ont réellement besoin (`migrate`, `studio`) la réclament
  // elles-mêmes, avec leur propre message.
  datasource: process.env["DATABASE_URL"] ? { url: process.env["DATABASE_URL"] } : {},
});
