/**
 * Theme (light/dark) composable for the SPA.
 *
 * Three-state: an explicit persisted user choice (`llm-quota.theme` =
 * 'light'|'dark'), else the OS `prefers-color-scheme`. The active theme is
 * written to `<html data-theme="...">` so the CSS semantic tokens re-map to
 * the matching primitives (see styles/base.css). No flash-of-wrong-theme: the
 * root App applies it before mount.
 */

import { reactive } from "vue";
import { safeGetItem, safeSetItem } from "./storage";

export type Theme = "light" | "dark";

const STORAGE_KEY = "llm-quota.theme";

/** Resolve the initial theme: persisted choice > system preference > light. */
export function resolveInitialTheme(): Theme {
  const stored = safeGetItem(STORAGE_KEY) as Theme | null;
  if (stored === "light" || stored === "dark") return stored;
  if (typeof window !== "undefined") {
    const sys = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    if (sys) return "dark";
  }
  return "light";
}

/** Apply `data-theme` on <html> and keep the reactive state for the toggle. */
export function useTheme() {
  const ui = reactive<{ theme: Theme }>({ theme: "light" });

  function apply(theme: Theme) {
    ui.theme = theme;
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }

  function toggle(next?: Theme) {
    const target = next ?? (ui.theme === "light" ? "dark" : "light");
    apply(target);
    safeSetItem(STORAGE_KEY, target);
  }

  /** Apply the initial theme (called before mount to avoid FOUC). */
  function init() {
    apply(resolveInitialTheme());
  }

  return { ui, apply, toggle, init };
}

/** Shared singleton so App (init) and any control share the same theme state. */
export const theme = useTheme();
