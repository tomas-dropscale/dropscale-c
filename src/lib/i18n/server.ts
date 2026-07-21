import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, getDictionary, isLocale, type Locale } from "@/lib/i18n";

/** Locale for the current request, read from the cookie set by the switcher. */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Dictionary for the current request — use in Server Components. */
export async function getServerDictionary() {
  const locale = await getLocale();
  return { locale, d: getDictionary(locale) };
}
