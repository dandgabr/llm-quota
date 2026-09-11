# ADR-011: Design System — Engineered Minimal Swiss (flat + mute pastel)

**Status:** accepted (Phase 6.5)

## Context

The web frontend was scaffolded in Phase 6 without a visual identity. The product
owner wants a **flat design with pastel tones** that deliberately avoids the
"AI-generated" look (the *sea of sameness* of gradients, glassmorphism, rounded
`2xl` card trios and Inter-only typography).

Research (web, 2026) and the `ui-ux-designer` skill converge on: flat-pastel is
the exact substrate where the soft-UI / claymorphism / candy cliché lives, and
pastel palettes frequently fail WCAG contrast. The antidote is restraint and
specificity, not decoration.

## Decisions

1. **Direction: Engineered Minimal Swiss** — a Swiss modular grid + grotesque
   typography, executed with tactile-minimalist craft (1px hairlines, a
   warm-bone surface ladder, micro-mono labels, single saturated accent), riding
   a **mute, desaturated pastel**. Pastel provides the requested tone; Swiss +
   hairline discipline keeps it an instrument, not candy.
2. **Color** — warm bone canvas (`#F7F4EF`), not pure white; pastel is reserved
   for **data fills** (sand/sage/rose/sky, desaturated); the **single accent is
   saturated periwinkle `#3E63DD`** for interactive/action/focus (WCAG AA).
   Status = desaturated fern-green / brick / ochre.
3. **Typography ("power couple")** — display **Space Grotesk** (heads + hero
   numbers, `tabular-nums`), body **IBM Plex Sans**, micro labels **JetBrains
   Mono** 11px uppercase 0.09em. No Inter-only; every quota figure uses tabular
   numbers.
4. **Flat depth** — hierarchy by **luminance surface ladder** + **1px hairline**,
   never blurred shadows or glassmorphism. Radius 2px cards / 4px controls; a
   tactile 2px press-flat shadow only on the primary button.
5. **Dataviz** — Chart.js defaults overridden: Color plugin off, desaturated
   pastel fills + hairline borders, single full-saturation line, flat tooltips,
   mono ticks, `role="img"` + `aria-label`.
6. **Anti-AI-slop ban list** — indigo→purple gradients, glassmorphism, three
   identical `rounded-2xl` cards, Inter-only, floating 3D blobs, pastel buttons,
   neubrutalism/claymorphism, pure `#ffffff` background.
7. **A11y (WCAG 2.2 AA)** — warm ink text ≈13:1 (AAA), accent vs bone ≈4.6:1
   (≥3:1 UI), visible `:focus-visible` ring in accent, min 44px touch targets,
   `prefers-reduced-motion` support, state never encoded by hue alone.

## Two themes (light + dark)

The design system ships **both a light and a dark theme**, driven by the
`data-theme` attribute on `<html>` (see `web/src/lib/theme.ts` + `base.css`):

- **Semantic tokens stay constant** (`--surface-base`, `--text-primary`,
  `--accent-action`, `--border-hairline`, …); only the **primitive tokens** re-map
  per theme, so components never know which theme is active.
- **Dark primitives keep the anti-slop discipline**: a warm dark-charcoal canvas
  (`#16130F`, not pure black), warm bone ink, desaturated data fills (sand/sage/
  rose/sky shifted darker), and the same single saturated periwinkle accent
  (lightened to `#6F8FF0` in dark for sufficient contrast on the dark surface).
- **Source of truth**: a persisted user choice (`llm-quota.theme`) wins; otherwise
  the OS `prefers-color-scheme` is honored; the root applies it before first paint
  to avoid a flash of the wrong theme.

## Consequences

- Consistent, authored look across the SPA via CSS tokens
  (`apps/web/src/styles/{tokens.ts,base.css}`) + ADR-011.
- A single saturated accent drives interactivity; pastel stays decorative/data.
- Accessibility is a first-class constraint of the palette, not an afterthought.
- Both themes share the semantic layer, so adding a theme is a primitive-only
  change and never touches components.
- The design system is captured so engineers hand off state/motion matrices and
  the frontend keeps the identity (ADR-006 documentation discipline).
