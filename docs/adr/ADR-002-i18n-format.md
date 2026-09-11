# ADR-002: i18n Format — ICU MessageFormat over JSON v4 (i18next), `en` + `pt-BR`

**Status:** accepted

## Context

The product must support multiple languages, shipping first with `en` and
`pt-BR`. File-based localization must be separated so translations can be edited
independently and be portable to future clients (desktop, gadget, GNOME
extension) that consume the same backend API. A web-researcher audit compared
how the market localizes a TypeScript/SaaS web stack.

## Alternatives considered

- **Mozilla Fluent (FTL)**: rich plural/select DSL, but heavy, a niche ecosystem
  in TypeScript, and awkward for JSON-only pipelines.
- **PO / gettext**: CLI/desktop heritage, poor fit for a JSON-centric web SPA.
- **XLIFF**: translation-exchange format, not a runtime UI resource format.
- **ICU MessageFormat over JSON v4 (i18next)**: mature, widely adopted in the
  TS/React/Vue ecosystem, supports pluralization/select/interpolation, namespacing
  and lazy loading; resource files are plain JSON, portable to any client.

## Decision

Adopt **i18next** with **ICU MessageFormat over JSON v4** resource files:

- One file per locale: `packages/i18n/locales/en.json` (canonical) and
  `packages/i18n/locales/pt-BR.json`.
- Keys namespaced by feature (e.g. `auth.*`, `connections.*`, `quota.*`,
  `history.*`).
- Locale resolution: explicit user locale with fallback `pt-BR → en → key`.
- All numeric/currency/date formatting via the standard `Intl` API in the
  consumer (`Intl.NumberFormat`, `Intl.DateTimeFormat`) — never hardcode a
  currency or unit inside a translated string.
- The same JSON resources are consumable by the future native clients.

## Consequences

- Low risk, industry-standard tooling; translations are plain JSON that any
  translator or tooling can edit without an extra DSL.
- Slight overhead of the i18next runtime in the browser (bundled, tree-shaken).
- Rejected: Fluent (ecosystem/DSL weight), gettext/PO and XLIFF (not a match for
  a JSON-centric web SPA).
