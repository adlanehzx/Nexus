/**
 * Stylesheets imported for side effects.
 *
 * Handled by Vite during build; TypeScript only knows ES modules.
 * Explicitly typed here rather than importing all of `vite/client`.
 */
declare module "*.css";

interface ImportMetaEnv {
  readonly VITE_NEXUS_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
