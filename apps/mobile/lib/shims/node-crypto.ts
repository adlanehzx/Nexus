/**
 * Stands in for `node:crypto` in the mobile bundle.
 *
 * See metro.config.js. Peer sync is not used on mobile. Refusing here matters
 * more than the bundling: encrypted sync must never appear to work without keys.
 */
function unavailable(name: string): () => never {
  return () => {
    throw new Error(`node:crypto.${name} is not available in the NEXUS mobile app.`);
  };
}

export const createCipheriv = unavailable("createCipheriv");
export const createDecipheriv = unavailable("createDecipheriv");
export const randomBytes = unavailable("randomBytes");
