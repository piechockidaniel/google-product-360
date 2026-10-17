import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { en, type TranslationKey } from './locales/en';
import { pl } from './locales/pl';

export type Lang = 'pl' | 'en';
export const LANGUAGES: { code: Lang; label: string; locale: string }[] = [
  { code: 'pl', label: 'Polski', locale: 'pl-PL' },
  { code: 'en', label: 'English', locale: 'en-US' },
];
const DEFAULT_LANG: Lang = 'pl';
const STORAGE_KEY = 'gmc.lang';

const dictionaries: Record<Lang, Record<TranslationKey, string>> = { pl, en };

export type Params = Record<string, string | number | null | undefined>;

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function translate(lang: Lang, key: TranslationKey | string, params?: Params): string {
  const dict = dictionaries[lang];
  const template = (dict as Record<string, string>)[key] ?? (en as Record<string, string>)[key] ?? key;
  return interpolate(template, params);
}

/** Translation with a fallback when the key is not known (for server-provided codes). */
export function translateOr(lang: Lang, key: string, fallback: string, params?: Params): string {
  const dict = dictionaries[lang] as Record<string, string>;
  const template = dict[key] ?? (en as Record<string, string>)[key];
  return template ? interpolate(template, params) : fallback;
}

export function detectLanguage(): Lang {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  if (stored === 'pl' || stored === 'en') return stored;
  return DEFAULT_LANG;
}

interface I18nState {
  lang: Lang;
  locale: string;
  setLang: (lang: Lang) => void;
  t: (key: TranslationKey, params?: Params) => string;
  /** Translate a dynamic key (server codes) with fallback text. */
  tOr: (key: string, fallback: string, params?: Params) => string;
  /** Translate a dynamic key, falling back to the key itself. */
  tk: (key: string, params?: Params) => string;
}

const I18nContext = createContext<I18nState | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLanguage);
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    localStorage.setItem(STORAGE_KEY, next);
    document.documentElement.lang = next;
  }, []);
  const value = useMemo<I18nState>(
    () => ({
      lang,
      locale: LANGUAGES.find((l) => l.code === lang)?.locale ?? 'pl-PL',
      setLang,
      t: (key, params) => translate(lang, key, params),
      tOr: (key, fallback, params) => translateOr(lang, key, fallback, params),
      tk: (key, params) => translateOr(lang, key, key, params),
    }),
    [lang, setLang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nState {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

/** Shorthand hook returning just the translate function. */
export function useT(): I18nState['t'] {
  return useI18n().t;
}

export function LanguageSwitcher({ compact }: { compact?: boolean }) {
  const { lang, setLang } = useI18n();
  return (
    <select className={`lang-switch ${compact ? 'lang-switch-compact' : ''}`} value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label="Language">
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {compact ? l.code.toUpperCase() : l.label}
        </option>
      ))}
    </select>
  );
}
