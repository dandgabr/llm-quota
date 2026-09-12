/**
 * Auth for llm-quota — OIDC abstraction, TOTP, WebAuthn, sessions and RBAC.
 *
 * Phase 4: functional implementations land here. Secrets are handled as
 * encrypted at rest (via `core` envelope crypto) and never logged; clock and
 * HTTP are injectable for tests.
 */

export * from "./rbac.js";
export * from "./totp.js";
export * from "./webauthn.js";
export * from "./oidc.js";
export * from "./session.js";
export * from "./password.js";
export * from "./recovery.js";
