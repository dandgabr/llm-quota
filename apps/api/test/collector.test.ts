import { describe, expect, it } from "vitest";
import { ProviderRegistry, type ProviderConnector } from "@llm-quota/providers";
import type { HistoryStore } from "@llm-quota/core";
import { runCollectPass, type CollectableConnection } from "../src/collector.js";

const NOW = new Date("2026-09-11T12:00:00Z");

/** A fake connector that returns a credits snapshot (shape 2.1 account total). */
const creditsConnector = (id: string): ProviderConnector => ({
  id,
  name: id,
  connectionType: "api",
  async fetchQuota() {
    return { kind: "credits", currency: "USD", total: 100 };
  },
});

/** A history store stub that records aggregate upserts. */
function makeHistory() {
  const aggregates: unknown[] = [];
  return {
    aggregates,
    store: {
      upsertAggregate: async (a: never) => {
        aggregates.push(a);
        return undefined;
      },
      listByUser: async () => [],
      evictOlderThan: async () => 0,
    } as unknown as HistoryStore,
  };
}

const conn = (over: Partial<CollectableConnection>): CollectableConnection => ({
  id: "c1",
  userId: "u1",
  providerId: "p1",
  connectorId: "ollama-claude/api",
  window: "daily",
  secret: "key",
  ...over,
});

describe("collector: minimized polling", () => {
  it("collects a connection that has never run (due)", async () => {
    const registry = new ProviderRegistry();
    registry.register(creditsConnector("ollama-claude/api"));
    const { store, aggregates } = makeHistory();
    const res = await runCollectPass(registry, store, [conn({ lastCollectedAt: undefined })], NOW);
    expect(res.collected).toBe(1);
    expect(res.skipped).toBe(0);
    expect(aggregates.length).toBe(1); // credits -> one aggregate upserted
  });

  it("skips a connection that ran recently (not due)", async () => {
    const registry = new ProviderRegistry();
    registry.register(creditsConnector("ollama-claude/api"));
    const { store } = makeHistory();
    const recent = new Date(NOW.getTime() - 60_000).toISOString(); // 1 min ago
    const res = await runCollectPass(registry, store, [conn({ lastCollectedAt: recent })], NOW);
    expect(res.collected).toBe(0);
    expect(res.skipped).toBe(1); // within hourly interval -> not due
  });

  it("collects when the window period has reset since last read", async () => {
    const registry = new ProviderRegistry();
    registry.register(creditsConnector("ollama-claude/api"));
    const { store } = makeHistory();
    // Daily calendar window: last read was yesterday (before today's period start).
    const yesterday = new Date(NOW.getTime() - 30 * 60 * 60_000).toISOString();
    const res = await runCollectPass(registry, store, [conn({ lastCollectedAt: yesterday })], NOW);
    expect(res.collected).toBe(1); // reset pending -> due
  });

  it("stages the next run times in the result", async () => {
    const registry = new ProviderRegistry();
    registry.register(creditsConnector("ollama-claude/api"));
    const { store } = makeHistory();
    const res = await runCollectPass(registry, store, [conn({})], NOW);
    expect(res.nextRuns[0]?.connectionId).toBe("c1");
    expect(res.nextRuns[0]?.at).toBeDefined();
  });
});
