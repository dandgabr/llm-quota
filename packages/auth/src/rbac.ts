import type { Role } from "@llm-quota/shared";

/**
 * RBAC enforcement helpers (require 9). `Role` lives in `@llm-quota/shared` so
 * the DTO and DB schema share one definition; `packages/auth` enforces it.
 */

export type { Role };

/** Server-side RBAC decision for an actor on a resource owner. */
export type Access = "allow" | "deny";

/** Role precedence: admin > supervisor > user. */
export const ROLE_RANK: Record<Role, number> = { admin: 2, supervisor: 1, user: 0 };

/**
 * Whether `actor` can VIEW the resource owned by `ownerId`. Owners always pass;
 * supervisors and admins may view another user's spend/quota (read-only).
 */
export function canViewActor(actorRole: Role, actorId: string, ownerId: string): Access {
  if (actorId === ownerId) return "allow";
  if (actorRole === "supervisor" || actorRole === "admin") return "allow";
  return "deny";
}

/**
 * Whether `actor` can MANAGE (mutate) the connections owned by `ownerId`.
 * Only the owner, or an admin, may mutate a connection.
 */
export function canManageConnections(actorRole: Role, actorId: string, ownerId: string): Access {
  if (actorId === ownerId) return "allow";
  if (actorRole === "admin") return "allow";
  return "deny";
}

/** Assert that the actor role meets at least a minimum role rank. */
export function assertRoleAtLeast(actorRole: Role, minimum: Role): boolean {
  return ROLE_RANK[actorRole] >= ROLE_RANK[minimum];
}

/** Convenience: does the actor meet at least the `minimum` role? */
export function hasRole(actorRole: Role, minimum: Role): boolean {
  return assertRoleAtLeast(actorRole, minimum);
}
