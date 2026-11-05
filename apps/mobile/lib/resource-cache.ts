/** What screens last fetched. Separate module: the provider clears it, and `use-resource` imports the provider. */
export const resourceCache = new Map<string, unknown>();

/** Forgets everything fetched: another account must never see these rows. */
export function clearResourceCache(): void {
  resourceCache.clear();
}
