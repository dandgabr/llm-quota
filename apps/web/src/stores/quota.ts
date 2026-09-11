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
    loading: false,
    loaded: false,
    error: null,
  }),
  getters: {
    /** Connection label lookup by id (falls back to id). */
    labelOf: (s) => (connectionId: string): string => {
      return s.connections.find((c) => c.id === connectionId)?.label ?? connectionId;
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
        const [quotas, connections, history] = await Promise.all([
          api.listQuotas(),
          api.listConnections(),
          api.readHistory(),
        ]);
        this.quotas = quotas;
        this.connections = connections;
        this.history = history;
      } catch (err) {
        this.error = err instanceof Error ? err.message : "Failed to load quotas";
      } finally {
        this.loading = false;
        this.loaded = true;
      }
    },
  },
});
