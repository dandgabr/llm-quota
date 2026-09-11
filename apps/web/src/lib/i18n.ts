/**
 * i18n composable for the SPA.
 *
 * Holds a module-level reactive translator so every view (and the root App
 * itself) renders the active locale, and locale switches re-render instantly.
 * Falls back to a pass-through `(key) => key` until the App loads the first
 * translator (useful for isolated tests).
 *
 * NOTE: the previous provide/inject approach called `provide()` inside an
 * async loader (after mount), so injection never happened and the whole app
 * rendered raw i18n keys — caught by the Phase 8 Playwright suite.
 */

import { ref } from "vue";
import type { Translator } from "@llm-quota/i18n";

const current = ref<Translator>((key: string) => key);

/** Swap the active translator (called by the root App on locale changes). */
export function setTranslator(t: Translator): void {
  current.value = t;
}

/** Stable translator function that always delegates to the active locale. */
export function useTranslator(): Translator {
  return (key: string, options?: Record<string, unknown>) => current.value(key, options);
}
