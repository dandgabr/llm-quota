/**
 * llm-quota design system tokens (CSS custom properties).
 *
 * Direction: Engineered Minimal Swiss — flat + mute pastel, explicitly
 * anti-"AI slop". Pastel is reserved for data fills/cards (desaturated dusty
 * tones); the single saturated accent drives interactivity. Hierarchy comes
 * from a warm-bone surface ladder + 1px hairlines, not blurred shadows or
 * glassmorphism. See docs/adr/ADR-011-design-system.md.
 */

export const tokens = {
  /** Primitives — bone (warm neutrals) */
  "bone-50": "#F7F4EF",
  "bone-100": "#ECE7DE",
  "bone-200": "#E4DED2",

  /** Primitives — ink (warm text, desaturated) */
  "ink-900": "#23201B", // ~13.2:1 on bone-50 (AAA)
  "ink-700": "#5C564C", // ~5.9:1 (AA)
  "ink-500": "#6E675B", // dark-enough muted; use ≥18px or mono labels only

  /** Primitives — data fills (muted pastel, not candy) */
  "sand-300": "#E3D5BD",
  "sage-300": "#C8D5C1",
  "rose-300": "#E0C4C4",
  "sky-300": "#C7D4E8",

  /** Primitives — single saturated accent + status */
  "periwinkle-500": "#3E63DD", // ~4.6:1 on bone (UI 3:1 + text 4.5:1)
  "fern-600": "#3E7A5C", // success / under-quota
  "brick-600": "#C44B3C", // danger / over-quota
  "ochre-600": "#A87C1F", // warning

  /** Primitives — hairline / dividers (warm black) */
  "hairline": "rgba(24,20,16,0.13)",
  "hairline-strong": "rgba(24,20,16,0.18)",
  "divider": "rgba(24,20,16,0.08)",

  /** Semantic surfaces */
  "surface-base": "var(--bone-50)",
  "surface-raised": "var(--bone-100)",
  "surface-elevated": "var(--bone-200)",

  /** Semantic text */
  "text-primary": "var(--ink-900)",
  "text-secondary": "var(--ink-700)",
  "text-muted": "var(--ink-500)",

  /** Semantic accent */
  "accent-action": "var(--periwinkle-500)",
  "accent-on-accent": "#FFFFFF",

  /** Status */
  "status-success": "var(--fern-600)",
  "status-danger": "var(--brick-600)",
  "status-warning": "var(--ochre-600)",

  /** Chart fills */
  "chart-fill-primary": "rgba(62,99,221,0.14)",
  "chart-fill-track": "rgba(24,20,16,0.06)",
  "chart-gridline": "rgba(24,20,16,0.08)",

  /** Radii — sharp instrument, not candy */
  "radius-0": "0px",
  "radius-card": "2px",
  "radius-control": "4px",

  /** Borders */
  "border-hairline": "1px solid var(--hairline)",
  "border-strong": "1px solid var(--hairline-strong)",
  "focus-ring": "2px solid var(--accent-action)",
  "focus-ring-offset": "2px",

  /** Typography */
  "font-display": "'Space Grotesk', 'Inter', system-ui, sans-serif",
  "font-body": "'IBM Plex Sans', system-ui, sans-serif",
  "font-mono": "'JetBrains Mono', ui-monospace, monospace",

  /** Spacing (4/8 scale) */
  "space-1": "4px",
  "space-2": "8px",
  "space-3": "12px",
  "space-4": "16px",
  "space-6": "24px",
  "space-8": "32px",
  "space-11": "64px",

  /** Motion */
  "ease-out-quart": "cubic-bezier(0.25, 1, 0.5, 1)",
  "transition-fast": "150ms var(--ease-out-quart)",
} as const;

/** Export the primitive + semantic namespace for TypeScript use. */
export type DesignTokenKey = keyof typeof tokens;

/** Flatten to a CSS variable map (`{ --bone-50: #F7F4EF, ... }`). */
export function toCssVars(prefix = "--"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) {
    out[`${prefix}${k}`] = v;
  }
  return out;
}

/** Generate a `:root { ... }` CSS string from the tokens. */
export function tokensToCss(): string {
  const vars = toCssVars();
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `:root {\n${body}\n}`;
}
