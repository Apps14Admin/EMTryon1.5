/**
 * LANGUAGE AND THEME — the two preferences that change how the app LOOKS,
 * and nothing about what it renders.
 *
 * One provider for both, because they are the same shape of thing: a small
 * value, remembered per browser, published to the document root so CSS can act
 * on it. Splitting them into two contexts would double the wiring for no gain.
 *
 * WHAT THIS DOES NOT TOUCH. No prompt, no enforcement rule, no product data,
 * no angle, no aspect ratio, no Library record. `t()` is applied at the leaf
 * where a string is DISPLAYED; nothing that is sent to a model, stored, or
 * compared ever passes through it.
 *
 * ── translation ───────────────────────────────────────────────────────────
 * The dictionary is keyed by the ENGLISH SOURCE STRING, so a call site reads
 * `t('Generate')` rather than `t('studio.generate')`. Two consequences, both
 * deliberate:
 *
 *   1. A string with no Arabic yet renders in English rather than as a raw
 *      key. A partly-translated interface is then merely partly translated,
 *      never broken.
 *   2. There is no key file to keep in step with the copy.
 *
 * ── what must never be translated ─────────────────────────────────────────
 * Product names, folder and file names, product and image ids, model ids,
 * generated image content, view names that reach the prompt (FRONT/BACK/…),
 * and the style directives themselves. `ltr()` wraps such a value so it keeps
 * left-to-right order inside an Arabic sentence.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AR } from './arabic';

export type Lang = 'en' | 'ar';
export type Theme = 'light' | 'dark';

const LANG_KEY = 'em_ui_lang';
const THEME_KEY = 'em_ui_theme';

const isLang = (v: unknown): v is Lang => v === 'en' || v === 'ar';
const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark';

const readStored = <T,>(key: string, ok: (v: unknown) => v is T, fallback: T): T => {
  if (typeof window === 'undefined') return fallback;
  try {
    const held = window.localStorage.getItem(key);
    return ok(held) ? held : fallback;
  } catch {
    return fallback;
  }
};

/**
 * The theme a browser with no saved choice opens on.
 *
 * Fixed to light, deliberately. This used to follow the OS via
 * `prefers-color-scheme`, which meant the same build opened dark for some
 * people and light for others with nothing saved either way. A first visit now
 * looks the same for everybody; the OS is consulted only after the user has
 * made a choice, and then it is their choice that is read, not the OS.
 */
const DEFAULT_THEME: Theme = 'light';

export interface UiPrefs {
  lang: Lang;
  setLang: (lang: Lang) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** 'rtl' while Arabic is selected. */
  dir: 'ltr' | 'rtl';
  /**
   * English source string in, the current language's text out.
   *
   * A string with values in it is written with named placeholders —
   * `t('Rendering angle {i} of {n}', { i, n })` — rather than assembled from
   * fragments. Arabic does not order a sentence the way English does, so a
   * translator has to be able to move the value within the sentence; splitting
   * the sentence at the call site takes that away and produces broken grammar.
   * An unfilled placeholder is left as written rather than blanked, so a
   * mismatch shows up on screen instead of silently losing the number.
   */
  t: (text: string, vars?: Record<string, string | number>) => string;
}

const UiPrefsContext = createContext<UiPrefs | null>(null);

export const UiPrefsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(() => readStored(LANG_KEY, isLang, 'en'));
  const [theme, setThemeState] = useState<Theme>(() => readStored(THEME_KEY, isTheme, DEFAULT_THEME));

  const dir: 'ltr' | 'rtl' = lang === 'ar' ? 'rtl' : 'ltr';

  // The document root carries both, because the whole styling layer keys off
  // it: `[data-theme="dark"]` remaps the colour utilities, `[dir="rtl"]`
  // mirrors the layout. Setting them here means no component has to know.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('lang', lang);
    root.setAttribute('dir', dir);
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* a browser with storage blocked still switches for this session */
    }
  }, [lang, dir]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* as above */
    }
  }, [theme]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);
  const setTheme = useCallback((next: Theme) => setThemeState(next), []);

  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) => {
      const out = lang === 'ar' ? AR[text] ?? text : text;
      if (!vars) return out;
      return out.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
    },
    [lang]
  );

  const value = useMemo<UiPrefs>(
    () => ({ lang, setLang, theme, setTheme, dir, t }),
    [lang, setLang, theme, setTheme, dir, t]
  );

  return <UiPrefsContext.Provider value={value}>{children}</UiPrefsContext.Provider>;
};

/**
 * The preferences. Safe outside the provider — a component rendered in
 * isolation (a test, a story) gets English and light rather than a crash.
 */
export const useUiPrefs = (): UiPrefs => {
  const held = useContext(UiPrefsContext);
  if (held) return held;
  return {
    lang: 'en',
    setLang: () => {},
    theme: 'light',
    setTheme: () => {},
    dir: 'ltr',
    t: (text: string, vars?: Record<string, string | number>) =>
      vars ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole)) : text,
  };
};

/** Just the translator, for the common case. */
export const useT = (): UiPrefs['t'] => useUiPrefs().t;

/**
 * Marks a value that must keep left-to-right order inside Arabic text — a
 * product name, an id, a filename, a model id, a measurement. The class is
 * defined once in index.html.
 */
export const ltrClass = 'ltr-value';
