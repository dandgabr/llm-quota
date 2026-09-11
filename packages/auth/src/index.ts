/**
 * Auth for llm-quota — Phase 0 scaffold.
 *
 * User profile roles; OIDC/TOTP/WebAuthn implementations land in Phase 4.
 */

export type Role = "user" | "supervisor" | "admin";

/** Server-side RBAC decision for an actor on a resource owner. */
export type Access = "allow" | "deny";

export function canViewActor(actorRole: Role, actorId: string, ownerId: string): Access {
  // Everyone can view their own data.
  if (actorId === ownerId) return "allow";
  // Supervisors and admins may view other users' spend/quota (read-only).
  if (actorRole === "supervisor" || actorRole === "admin") return "allow";
  return "deny";
}

export function canManageConnections(actorRole: Role, actorId: string, ownerId: string): Access {
  // Only the owner (or an admin) can mutate a connection.
  if (actorId === ownerId) return "allow";
  if (actorRole === "admin") return "allow";
  return "deny";
}
