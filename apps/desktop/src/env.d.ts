/**
 * Les feuilles de style importées pour leur effet de bord.
 *
 * Vite les prend en charge à la compilation ; TypeScript, lui, ne connaît que
 * des modules. On lui décrit la forme plutôt que d'ajouter `vite/client` en
 * entier, qui ferait entrer tout un environnement global dans la portée pour un
 * seul import.
 */
declare module "*.css";

interface ImportMetaEnv {
  readonly VITE_NEXUS_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
