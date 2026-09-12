/**
 * Pinia store for the caller's session: token, role and login/logout.
 *
 * The token is persisted to localStorage so a refresh keeps the session; the
 * backend still validates it on every request. Role gates UI affordances
 * (e.g. the admin nav / supervisor summary).
 */

import { defineStore } from "pinia";
import type { Role } from "@llm-quota/shared";
import { ApiClient, type ApiOptions } from "../lib/api";
import { safeGetItem, safeRemoveItem, safeSetItem } from "../lib/storage";

const TOKEN_KEY = "llm-quota.token";
const ROLE_KEY = "llm-quota.role";

export interface LoginInput {
  /** Session token as returned by the API login/issuance flow. */
  token: string;
  role?: Role;
}

export interface AuthState {
  token: string | null;
  role: Role | null;
}

/** Build a typed API client bound to the current token (if any). */
function clientFor(token: string, opts?: ApiOptions): ApiClient {
  return new ApiClient(token, opts);
}

export const useAuthStore = defineStore("auth", {
  state: (): AuthState => ({
    token: safeGetItem(TOKEN_KEY),
    role: (safeGetItem(ROLE_KEY) as Role | null) ?? null,
  }),
  getters: {
    isAuthenticated: (s) => !!s.token,
    isAdmin: (s) => s.role === "admin",
    isSupervisor: (s) => s.role === "supervisor" || s.role === "admin",
  },
  actions: {
    /** Establish a session from an issued token + role. */
    login(input: LoginInput) {
      this.token = input.token;
      this.role = input.role ?? null;
      safeSetItem(TOKEN_KEY, input.token);
      if (input.role) safeSetItem(ROLE_KEY, input.role);
    },
    /** Clear the session locally. */
    logout() {
      this.token = null;
      this.role = null;
      safeRemoveItem(TOKEN_KEY);
      safeRemoveItem(ROLE_KEY);
    },
    /** API accessor; returns null when unauthenticated. */
    api(opts?: ApiOptions): ApiClient | null {
      return this.token ? clientFor(this.token, opts) : null;
    },
  },
});
