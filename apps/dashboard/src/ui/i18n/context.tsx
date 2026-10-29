import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Locale, Translations } from "./types.js";
import { en } from "./locales/en.js";
import { fr } from "./locales/fr.js";

const STORAGE_KEY = "nexus_locale";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (path: string, vars?: Record<string, string | number>) => string;
  translations: Translations;
}

const DICTIONARIES: Record<Locale, Translations> = { en, fr };

const I18nContext = createContext<I18nContextValue | null>(null);

function detectInitialLocale(): Locale {
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    if (saved === "fr" || saved === "en") return saved;
    if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("fr")) {
      return "fr";
    }
  } catch {
    // SessionStorage or navigator inaccessible
  }
  return "en";
}

function resolveDottedPath(obj: unknown, path: string): string | undefined {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
    try {
      window.sessionStorage.setItem(STORAGE_KEY, nextLocale);
      document.documentElement.lang = nextLocale;
    } catch {
      // Ignore storage errors
    }
  }, []);

  useEffect(() => {
    try {
      document.documentElement.lang = locale;
    } catch {
      // Ignore DOM attribute errors
    }
  }, [locale]);

  const t = useCallback(
    (path: string, vars?: Record<string, string | number>): string => {
      const activeDict = DICTIONARIES[locale];
      const fallbackDict = DICTIONARIES.en;

      let result = resolveDottedPath(activeDict, path) ?? resolveDottedPath(fallbackDict, path);

      if (result === undefined) {
        return path;
      }

      if (vars !== undefined) {
        for (const [key, val] of Object.entries(vars)) {
          result = result.replace(new RegExp(`\\{${key}\\}`, "g"), String(val));
        }
      }

      return result;
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t,
      translations: DICTIONARIES[locale],
    }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (context === null) {
    return {
      locale: "en",
      setLocale: () => undefined,
      t: (path: string) => path,
      translations: en,
    };
  }
  return context;
}
