/**
 * Pinia store for quota + connection data consumed by the dashboard/history.
 */

import { defineStore } from "pinia";
import type { ConnectionView, HistoryPoint, QuotaView } from "../lib/api";
import { useAuthStore } from "./auth";

export interface QuotaState {
  quotas: QuotaView[];
  connections: ConnectionView[];
  history: HistoryPoint[];
  fxRateUsdToBrl: number;
  loading: boolean;
  /** true once the first successful load has completed (drives skeletons). */
  loaded: boolean;
  error: string | null;
}

export const useQuotaStore = defineStore("quota", {
  state: (): QuotaState => ({
    quotas: [],
    connections: [],
    history: [],
    fxRateUsdToBrl: 5.5,
    loading: false,
    loaded: false,
    error: null,
  }),
  getters: {
    /** Connection label lookup by id (falls back to id). */
    labelOf: (s) => (connectionId: string): string => {
      return s.connections.find((c) => c.id === connectionId)?.label ?? connectionId;
    },
    /** Quotas grouped by connectionId. */
    quotasFor: (s) => (connectionId: string): QuotaView[] => {
      return s.quotas.filter((q) => q.connectionId === connectionId);
    },
  },
  actions: {
    async refreshAll() {
      const auth = useAuthStore();
      const api = auth.api();
      if (!api) return;
      this.loading = true;
      this.error = null;
      try {
        const [quotas, connections, history, fx] = await Promise.all([
          api.listQuotas(),
          api.listConnections(),
          api.readHistory(),
          api.getFxRate("BRL", "USD").catch(() => ({ rate: 5.5 })),
        ]);
        this.quotas = quotas;
        this.connections = connections;
        this.history = history;
        if (fx?.rate) this.fxRateUsdToBrl = fx.rate;
      } catch (err) {
        this.error = err instanceof Error ? err.message : "Failed to load quotas";
      } finally {
        this.loading = false;
        this.loaded = true;
      }
    },

    async deleteConnection(id: string) {
      const auth = useAuthStore();
      const api = auth.api();
      if (!api) return;
      await api.deleteConnection(id);
      this.connections = this.connections.filter((c) => c.id !== id);
      this.quotas = this.quotas.filter((q) => q.connectionId !== id);
    },

    async updateConnection(id: string, input: { label?: string; secret?: string }) {
      const auth = useAuthStore();
      const api = auth.api();
      if (!api) return;
      const updated = await api.updateConnection(id, input);
      const idx = this.connections.findIndex((c) => c.id === id);
      if (idx >= 0) this.connections[idx] = updated;
      await this.refreshAll();
    },
  },
});
