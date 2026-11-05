import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { readPreference, writePreference } from "./preferences.js";

/**
 * Biometric gate.
 *
 * The app can read a person's conversations and drive their machines, so an
 * unlocked phone should not be enough when they say so. Two separate choices:
 * locking the app, and confirming remote control. Both use the OS prompt with
 * its passcode fallback; NEXUS never sees biometric data.
 */

/** Grace period, so a glance at another app does not demand Face ID again. */
const RELOCK_AFTER_MS = 60_000;

export interface BiometricSupport {
  available: boolean;
  /** Hardware exists but nothing is enrolled. */
  needsEnrollment: boolean;
}

export async function biometricSupport(): Promise<BiometricSupport> {
  try {
    const [hardware, level] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.getEnrolledLevelAsync(),
    ]);
    const enrolled = level !== LocalAuthentication.SecurityLevel.NONE;
    return { available: enrolled, needsEnrollment: hardware && !enrolled };
  } catch {
    return { available: false, needsEnrollment: false };
  }
}

export async function authenticate(reason: string): Promise<boolean> {
  try {
    return (await LocalAuthentication.authenticateAsync({ promptMessage: reason })).success;
  } catch {
    return false;
  }
}

interface AppLockValue {
  ready: boolean;
  locked: boolean;
  lockEnabled: boolean;
  confirmRemote: boolean;
  unlock: () => Promise<void>;
  setLockEnabled: (enabled: boolean) => Promise<boolean>;
  setConfirmRemote: (enabled: boolean) => Promise<boolean>;
  /** Gate for a remote action. Passes without a prompt when the setting is off. */
  confirmRemoteAction: (reason: string) => Promise<boolean>;
}

const AppLockContext = createContext<AppLockValue | undefined>(undefined);

export function AppLockProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [lockEnabled, setLockState] = useState(false);
  const [confirmRemote, setConfirmState] = useState(true);
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    void (async () => {
      const [lock, remote, support] = await Promise.all([
        readPreference("nexus.appLock"),
        readPreference("nexus.confirmRemote"),
        biometricSupport(),
      ]);
      // A lock that cannot be opened (enrollment removed) would brick the app.
      const enabled = lock === "true" && support.available;
      setLockState(enabled);
      setLocked(enabled);
      setConfirmState(remote !== "false" && support.available);
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "background") backgroundedAt.current = Date.now();
      if (status !== "active") return;
      const since = backgroundedAt.current;
      backgroundedAt.current = null;
      if (lockEnabled && since !== null && Date.now() - since > RELOCK_AFTER_MS) setLocked(true);
    });
    return () => {
      subscription.remove();
    };
  }, [lockEnabled]);

  const unlock = useCallback(async () => {
    if (await authenticate("Unlock NEXUS")) setLocked(false);
  }, []);

  const setLockEnabled = useCallback(async (enabled: boolean) => {
    if (enabled && !(await authenticate("Enable the NEXUS app lock"))) return false;
    setLockState(enabled);
    await writePreference("nexus.appLock", String(enabled));
    return true;
  }, []);

  const setConfirmRemote = useCallback(async (enabled: boolean) => {
    // Turning the protection off is itself protected.
    if (!(await authenticate("Change remote control protection"))) return false;
    setConfirmState(enabled);
    await writePreference("nexus.confirmRemote", String(enabled));
    return true;
  }, []);

  const confirmRemoteAction = useCallback(
    async (reason: string) => (confirmRemote ? authenticate(reason) : true),
    [confirmRemote],
  );

  const value = useMemo<AppLockValue>(
    () => ({
      ready,
      locked,
      lockEnabled,
      confirmRemote,
      unlock,
      setLockEnabled,
      setConfirmRemote,
      confirmRemoteAction,
    }),
    [
      ready,
      locked,
      lockEnabled,
      confirmRemote,
      unlock,
      setLockEnabled,
      setConfirmRemote,
      confirmRemoteAction,
    ],
  );

  return <AppLockContext.Provider value={value}>{children}</AppLockContext.Provider>;
}

export function useAppLock(): AppLockValue {
  const value = useContext(AppLockContext);
  if (value === undefined) throw new Error("useAppLock must be used within <AppLockProvider>");
  return value;
}

export function useBiometricSupport(): BiometricSupport | undefined {
  const [support, setSupport] = useState<BiometricSupport>();
  useEffect(() => {
    void biometricSupport().then(setSupport);
  }, []);
  return support;
}
