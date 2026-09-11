/**
 * i18n runtime for llm-quota — Phase 0 scaffold.
 *
 * ICU MessageFormat on JSON v4 resources (i18next), `en` canonical with
 * `pt-BR` fallback. See docs/adr/ADR-002.
 *
 * @example
 *   const t = await createTranslator("pt-BR");
 *   t("connections.add");
 */

import i18next, { type i18n } from "i18next";
import en from "../locales/en.json" with { type: "json" };
import ptBR from "../locales/pt-BR.json" with { type: "json" };

/** Locale codes the product ships. */
export const SUPPORTED_LOCALES = ["en", "pt-BR"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Default locale when none is supplied. */
export const DEFAULT_LOCALE: SupportedLocale = "en";

const resources = {
  en: { translation: en },
  "pt-BR": { translation: ptBR },
} as const;

/** Build the locale fallback chain: explicit locale -> en -> fallback key. */
export function localeChain(locale: string): string[] {
  if (locale === "en") return ["en"];
  if (locale === "pt-BR") return ["pt-BR", "en"];
  return [locale, "en"];
}

let instance: i18n | null = null;

/** Translator function resolving a namespaced key to the target locale string. */
export type Translator = (key: string, options?: Record<string, unknown>) => string;

/** Create (or reuse) a translator bound to the given locale. */
export async function createTranslator(
  locale: string = DEFAULT_LOCALE,
): Promise<Translator> {
  if (!instance) {
    instance = i18next.createInstance();
    await instance.init({
      resources,
      lng: locale,
      fallbackLng: localeChain(locale),
      interpolation: { escapeValue: false },
    });
  } else {
    await instance.changeLanguage(locale);
  }
  return (key, options = {}) => {
    if (!instance) return key;
    return String(instance.t(key, options));
  };
}
