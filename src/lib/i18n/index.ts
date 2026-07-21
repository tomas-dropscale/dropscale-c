import { en, pt, ptBR, es, fr, type Dictionary } from "@/lib/i18n/dictionaries";

export type { Dictionary };
export type Locale = "en" | "pt" | "pt-BR" | "es" | "fr";

/** Order here is the order shown in the settings switcher. */
export const LOCALES: Locale[] = ["en", "pt", "pt-BR", "es", "fr"];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "dropscale-locale";

/** Endonyms — a language is always listed in its own words. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  pt: "Português (Portugal)",
  "pt-BR": "Português (Brasil)",
  es: "Español",
  fr: "Français",
};

/** Two-letter badge; "pt-BR" would be too wide for the chip. */
export const LOCALE_BADGES: Record<Locale, string> = {
  en: "EN",
  pt: "PT",
  "pt-BR": "BR",
  es: "ES",
  fr: "FR",
};

const DICTIONARIES: Record<Locale, Dictionary> = {
  en,
  pt,
  "pt-BR": ptBR,
  es,
  fr,
};

export function isLocale(value: string | undefined | null): value is Locale {
  return LOCALES.includes(value as Locale);
}

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}

/** Fills {placeholders}. Unknown keys are left untouched so they stay visible. */
export function fmt(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/**
 * BCP-47 tag for Intl / toLocaleString. Only number and date shapes change —
 * the workspace bills in EUR whatever the interface language is.
 */
const INTL_TAGS: Record<Locale, string> = {
  en: "en-GB",
  pt: "pt-PT",
  "pt-BR": "pt-BR",
  es: "es-ES",
  fr: "fr-FR",
};

export function intlLocale(locale: Locale) {
  return INTL_TAGS[locale];
}
