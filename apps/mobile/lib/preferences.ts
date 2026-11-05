import * as SecureStore from "expo-secure-store";

/**
 * Small persisted preferences.
 *
 * SecureStore is used for lack of a need for anything else: the values are few
 * and short, and it avoids a second storage dependency. Reads never throw; an
 * unreadable preference is the default.
 */

export type PreferenceKey =
  | "nexus.server"
  | "nexus.speakReplies"
  | "nexus.appLock"
  | "nexus.confirmRemote"
  | "nexus.notifications"
  | "nexus.sendMode";

export async function readPreference(key: PreferenceKey): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function writePreference(key: PreferenceKey, value: string | null): Promise<void> {
  try {
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    // Not fatal: the choice still applies for this launch.
  }
}
