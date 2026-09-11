/**
 * i18n composable for the SPA.
 *
 * Provides a translator bound to the app's current locale. The root App provides
 * `"t"` (a plain Translator function) after loading it; views that need
 * translation call `useTranslator()` to inject it. Falls back to a pass-through
 * `(key) => key` when not provided (testable without the app root).
 */

import { inject } from "vue";
import type { Translator } from "@llm-quota/i18n";

const INJECTION_KEY = "t" as const;

/** Return the injected translator (identity fallback when absent). */
export function useTranslator(): Translator {
  const t = inject<Translator>(INJECTION_KEY);
  return t ?? ((key: string) => key);
}
