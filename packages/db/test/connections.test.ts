import { describe, expect, it } from "vitest";
import { encryptSecret, generateDek } from "@llm-quota/core";
import { PostgresConnectionStore, type ConnectionRow } from "../src/repositories/connections.js";

/** Minimal mock DB for the connection store (no live Postgres). */
function mockDb() {
  const rows = new Map<string, ConnectionRow>();
  return {
    rows,
    insert: () => ({
      values: (v: ConnectionRow) => ({
        returning: async (): Promise<ConnectionRow[]> => {
          const id = `conn-${rows.size + 1}`;
          const row: ConnectionRow = { ...(v as unknown as ConnectionRow), id } as ConnectionRow;
          rows.set(id, row);
          return [row];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            [...rows.values()].filter((r) => r.id).slice(0, 1),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => Promise.resolve() }) }),
    delete: () => ({ where: async () => Promise.resolve() }),
  };
}

describe("PostgresConnectionStore envelope crypto", () => {
  it("seals the secret at rest and never stores plaintext", async () => {
    const kek = generateDek();
    const db = mockDb();
    const store = new PostgresConnectionStore(db as never, kek);
    const created = await store.create({
      userId: "u1",
      providerId: "p1",
      label: "team",
      connectionType: "api",
      secret: "super-secret-key-abc",
    });
    expect(created.secretCipher).toBeTruthy();
    expect(created.secretCipher).not.toContain("super-secret-key-abc");
    expect(created.secretCipher.startsWith("v1.")).toBe(true);
  });

  it("decrypts the stored ciphertext back to the original secret", async () => {
    const kek = generateDek();
    const cipher = encryptSecret("refresh-token-xyz", kek);
    expect(cipher.startsWith("v1.")).toBe(true);
    // Round-trip at the helper level (the store decrypt path is exercised by
    // findById against a live DB; here we validate the format is decryptable).
    const { decryptSecret } = await import("@llm-quota/core");
    expect(decryptSecret(cipher, kek)).toBe("refresh-token-xyz");
  });

  it("fails to decrypt with a different KEK", async () => {
    const kek = generateDek();
    const cipher = encryptSecret("secret-a", kek);
    const other = generateDek();
    const { decryptSecret } = await import("@llm-quota/core");
    expect(() => decryptSecret(cipher, other)).toThrow();
  });
});
