"use client";

import * as React from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  getDictionary,
  intlLocale,
  type Dictionary,
  type Locale,
} from "@/lib/i18n";

type I18nValue = {
  locale: Locale;
  d: Dictionary;
  /** BCP-47 tag for toLocaleString / Intl. */
  intl: string;
};

const I18nContext = React.createContext<I18nValue | null>(null);

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  const value = React.useMemo<I18nValue>(
    () => ({ locale, d: getDictionary(locale), intl: intlLocale(locale) }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = React.useContext(I18nContext);

  // Falling back keeps standalone rendering (tests, storybook) working instead
  // of throwing — the default locale is always a valid dictionary.
  if (!value) {
    return { locale: DEFAULT_LOCALE, d: getDictionary(DEFAULT_LOCALE), intl: "en-GB" };
  }
  return value;
}

/** Persists the choice and reloads Server Components so server copy updates too. */
export function setLocaleCookie(locale: Locale) {
  const oneYear = 60 * 60 * 24 * 365;
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${oneYear}; samesite=lax`;
}
