# Code Documentation Conventions

This document defines the documentation standard for llm-quota source code. It
applies to all packages and is enforced by convention (and, where noted, by
tooling).

## Language of documentation

- Code documentation (comments, JSDoc/TSDoc) is written in **English**,
  consistent with the repository-wide English convention (ADR-001).

## Doc format by language

The project is fully **TypeScript**, so the canonical format is **TSDoc** (the
TypeScript-flavoured JSDoc that tools like `typedoc`, `api-extractor` and
editors understand). Rules:

1. **Public exports get a doc comment.** Every exported function, class,
   interface, type, enum value, constant and module-facing symbol carries a
   `/** ... */` block describing its purpose.
2. **Describe behaviour, not mechanics.** State what a function does, its
   preconditions and return contract. Avoid restating the code line by line.
3. **Tag usage** (`@param`, `@returns`, `@throws`, `@example`, `@see`) is used
   when it adds information beyond the summary line. Do not add tags that only
   repeat the signature.
4. **Interface/type members** get short doc lines where a reader would otherwise
   have to guess (e.g. units, valid ranges, meaning of an optional field).
5. **Module header.** Each source module starts with a short comment explaining
   its responsibility and any relevant ADR/design reference.
6. **No doc noise.** Do not add comments that merely restate the identifier or
   echo the code. Prefer fewer, accurate comments over many redundant ones.

## Schema (Drizzle) documentation

- Each table/column that is not self-evident is documented with a TSDoc line
  (e.g. "stored encrypted", "ISO instant", "0 when unlimited").
- The schema module header references the domain entity it maps.

## Conventions for the docs/ tree

- Living documents live under `docs/` (architecture, plan, security, testing,
  deploy). ADRs under `docs/adr/` are immutable once accepted; to change one,
  write a new ADR and mark the old as superseded.
- Diagrams use Mermaid/PlantUML as appropriate (see `docs/architecture/overview.md`).

## Future languages

Rules 1-6 are the template. If a non-TS language is added later, adopt its
native doc standard (e.g. Rust `///` doc comments, C/C++ Doxygen/Doxygen-style,
JavaDoc, Python docstrings/PEP 257) following the same "public surface
documented, behaviour-focused, English, no noise" principles.
