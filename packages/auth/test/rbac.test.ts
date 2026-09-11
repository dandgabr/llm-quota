import { describe, expect, it } from "vitest";
import { canManageConnections, canViewActor } from "../src/index.js";

describe("RBAC", () => {
  it("lets a user view and manage their own data", () => {
    expect(canViewActor("user", "1", "1")).toBe("allow");
  });

  it("lets a supervisor view another user's spend", () => {
    expect(canViewActor("supervisor", "9", "2")).toBe("allow");
  });

  it("denies a plain user from viewing another user's data", () => {
    expect(canViewActor("user", "1", "2")).toBe("deny");
  });

  it("lets a supervisor manage only their own connections", () => {
    expect(canManageConnections("supervisor", "9", "2")).toBe("deny");
    expect(canManageConnections("supervisor", "2", "2")).toBe("allow");
  });
});
