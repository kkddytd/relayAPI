import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en } from "@/i18n/en";
import { zh } from "@/i18n/zh";
import type { I18nMessages, Language } from "@/i18n/types";

const LANGUAGE_STORAGE_KEY = "api_verifier_lang";

const dictionaries: Record<Language, I18nMessages> = {
  zh,
  en,
};

export type I18nKey = keyof I18nMessages;
export type TranslateFn = (key: I18nKey) => string;

interface I18nContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  messages: I18nMessages;
  t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function normalizeLanguage(input: string | null | undefined): Language | null {
  if (!input) return null;
  const lowered = input.toLowerCase();
  if (lowered.startsWith("zh")) return "zh";
  if (lowered.startsWith("en")) return "en";
  return null;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>("zh");

  const setLang = useCallback((nextLang: Language) => {
    setLangState(nextLang);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLang);
      } catch {
        // The selected language remains active for this session.
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
      if (saved) {
        setLangState(saved);
      }
    } catch {
      // Private browsing may deny storage access.
    }
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const messages = useMemo(() => dictionaries[lang], [lang]);
  const t = useCallback<TranslateFn>((key) => messages[key], [messages]);

  const value = useMemo(
    () => ({ lang, setLang, messages, t }),
    [lang, setLang, messages, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
