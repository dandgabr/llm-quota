# ADR-006: Code Documentation Standard — TSDoc and English (all languages)

**Status:** accepted

## Context

The project grew a substantial public surface across `packages/*` (core, db,
providers, auth, i18n, shared) and `apps/*`. Documentation coverage was
inconsistent: some modules were well-documented, others (e.g. `math.ts`,
`main.ts`, several schema/repository files) had sparse or no doc comments. A
single convention is needed so every symbol of the public surface is documented
in a consistent, useful way, and so future non-TS languages follow an
equivalent standard.

## Decision

1. **Format: TSDoc** (the TypeScript JSDoc superset). Every exported function,
   class, interface, type, enum value, constant and module-facing symbol carries
   a `/** ... */` block describing its purpose. Behaviour-focused, not
   mechanical; tags (`@param`, `@returns`, `@throws`, `@example`, `@see`) added
   only when they add information beyond the summary. Interface/type members are
   documented where a reader would otherwise guess.
2. **Module headers.** Every source module starts with a short comment stating
   responsibility and any ADR/design reference.
3. **Schema (Drizzle)** tables/columns are documented where not self-evident.
4. **Language: English** — consistent with the repository-wide convention
   (ADR-001). Chat with the user stays PT-BR; all artifacts are EN.
5. **Portability.** For future non-TS languages, adopt the native doc standard
   (Rust `///`, Doxygen/JavaDoc for C/C++/Java, PEP 257 docstrings for Python)
   following the same "public surface documented, behaviour-focused, English,
   no noise" principles.
6. The full standard is captured in
   `docs/architecture/code-documentation-conventions.md`.

## Consequences

- Consistent, reviewable documentation across packages; editors/tools (TSDOC,
  `typedoc`) can consume it.
- Lower onboarding cost and clearer contracts for the connector/provider and
  API layers.
- Slight maintenance overhead per change; mitigated by keeping comments
  succinct and behaviour-focused.
- The convention is recorded as a living doc + ADR so future contributors
  follow it.
