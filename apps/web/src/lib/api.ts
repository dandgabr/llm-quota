/**
 * Typed API client for the llm-quota SPA (Phase 6; Phase A adds users/invites).
 *
 * Wraps the shared `HttpClient` (ADR-009) against the backend REST API
 * (ADR-008). Reads that take a body use the GET alias so the browser works
 * without a QUERY CORS preflight; the canonical QUERY contract stays on the
 * API/gateway side. The base URL defaults to same-origin so the SPA works when
 * served by the API (`WEB_DIST_PATH`); `VITE_API_URL` overrides it for the
 * two-port dev setup only.
 */

import { createFetchHttpClient, type HttpClient, type HttpResponse } from "@llm-quota/shared";

export interface ModelGroupQuota {
  name: string;
  models?: string[];
  session?: {
    usedPercent: number;
    remainingPercent: number;
    resetsAt?: string;
  };
  weekly?: {
    usedPercent: number;
    remainingPercent: number;
    resetsAt?: string;
  };
}

export interface QuotaView {
  id: string;
  connectionId: string;
  kind: "percent" | "credits";
  window?: string;
  usedPercent: number;
  remainingPercent: number;
  usedAmount?: number;
  remainingAmount?: number;
  currency?: string;
  resetAt?: string;
  resetsAt?: string;
  modelGroups?: ModelGroupQuota[];
}

export interface ConnectionView {
  id: string;
  providerKey: string;
  label: string;
  connectionType: "api" | "oauth";
  status: "ok" | "error" | "unconfigured";
  createdAt: string;
}

export interface HistoryPoint {
  windowKey: string;
  spentAmount: number;
  currency: string;
  /** Granularity window this point belongs to (daily|weekly|monthly). */
  granularity?: "daily" | "weekly" | "monthly";
}

export type Role = "user" | "supervisor" | "admin";

export interface UserView {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: Role;
  locale: string;
  isActive: boolean;
  hasPassword: boolean;
  createdAt: string;
}

export interface InviteView {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AuditEventView {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
}

/** Result of `POST /auth/login`: either a session or an MFA challenge. */
export type LoginResult =
  | { status: "mfa_required"; methods: string[]; challenge: string }
  | { status?: undefined; token: string; expiresAt: string; user: UserView };

/** RFC 7807 problem payload returned by the API on errors. */
interface ProblemBody {
  type?: string;
  title?: string;
  detail?: string;
  invalid_params?: { name: string; reason: string }[];
}

/** Typed error carrying the HTTP status + problem details. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    title: string,
    readonly detail?: string,
    readonly invalidParams?: { name: string; reason: string }[],
  ) {
    super(title);
    this.name = "ApiError";
  }

  /** Stable error class from the problem `type` URI (last path segment). */
  get code(): string {
    return this.problemType?.split("/").pop() ?? "unknown";
  }

  problemType?: string;
}

/** Injected HTTP + config so the client is testable offline. */
export interface ApiOptions {
  http?: HttpClient;
  baseUrl?: string;
  /** Called on any 401 so the shell can redirect to login (injected, no router import). */
  onUnauthorized?: () => void;
}

/**
 * Resolve the API base URL. Defaults to same-origin (`""`) so a build served
 * by the API talks to itself; the two-port dev setup sets `VITE_API_URL`.
 */
export function resolveApiBaseUrl(importMetaEnv: Record<string, string | undefined> = {}): string {
  return importMetaEnv.VITE_API_URL ?? "";
}

/** Convert a non-ok response into a typed `ApiError`. */
async function toApiError(res: HttpResponse): Promise<ApiError> {
  let body: ProblemBody = {};
  try {
    body = (await res.json()) as ProblemBody;
  } catch {
    // non-JSON error body
  }
  const err = new ApiError(
    res.status,
    body.title ?? `Request failed (${res.status})`,
    body.detail,
    body.invalid_params,
  );
  err.problemType = body.type;
  return err;
}

/** Public (unauthenticated) API surface for onboarding. */
export class PublicApiClient {
  private readonly http: HttpClient;
  private readonly base: string;

  constructor(opts: ApiOptions = {}) {
    this.http = opts.http ?? createFetchHttpClient();
    this.base = opts.baseUrl ?? resolveApiBaseUrl(import.meta.env as Record<string, string | undefined>);
  }

  private async handle<T>(res: HttpResponse): Promise<T> {
    if (!res.ok) throw await toApiError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async setupStatus(): Promise<{ required: boolean }> {
    return this.handle<{ required: boolean }>(await this.http.get(`${this.base}/auth/setup/status`));
  }

  async login(input: { email: string; password: string }): Promise<LoginResult> {
    return this.handle<LoginResult>(
      await this.http.post(`${this.base}/auth/login`, JSON.stringify(input), {
        "Content-Type": "application/json",
      }),
    );
  }

  async loginMfa(input: { challenge: string; code: string }): Promise<{
    token: string;
    expiresAt: string;
    user: UserView;
  }> {
    return this.handle(
      await this.http.post(`${this.base}/auth/login/mfa`, JSON.stringify(input), {
        "Content-Type": "application/json",
      }),
    );
  }

  async setup(input: {
    token: string;
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    locale?: string;
  }): Promise<{ token: string; expiresAt: string; user: UserView }> {
    return this.handle(
      await this.http.post(`${this.base}/auth/setup`, JSON.stringify(input), {
        "Content-Type": "application/json",
      }),
    );
  }

  async acceptInvite(input: {
    token: string;
    password: string;
    firstName?: string;
    lastName?: string;
    locale?: string;
  }): Promise<{ token: string; expiresAt: string; user: UserView }> {
    return this.handle(
      await this.http.post(`${this.base}/auth/invites/accept`, JSON.stringify(input), {
        "Content-Type": "application/json",
      }),
    );
  }
}

/** Typed client bound to a bearer token. */
export class ApiClient {
  private readonly http: HttpClient;
  private readonly base: string;

  constructor(
    private token: string,
    private readonly opts: ApiOptions = {},
  ) {
    this.http = opts.http ?? createFetchHttpClient();
    this.base = opts.baseUrl ?? resolveApiBaseUrl(import.meta.env as Record<string, string | undefined>);
  }

  /** Authorization header for every request. */
  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  /** Token rotation (H2): adopt a fresh session token from the server. */
  private tokenRefresher?: (token: string) => void;
  /** Wire the refresher once (called by the auth store at login). */
  setTokenRefresher(fn: (token: string) => void): void {
    this.tokenRefresher = fn;
  }

  /** Shared response handling: rotation, 401 hook, then typed errors. */
  private async handle<T>(res: HttpResponse): Promise<T> {
    const rotated =
      res.header?.("x-rotated-session") ?? res.header?.("X-Rotated-Session") ?? null;
    if (rotated) {
      this.token = rotated;
      this.tokenRefresher?.(rotated);
    }
    if (!res.ok) {
      if (res.status === 401) this.opts.onUnauthorized?.();
      throw await toApiError(res);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async listQuotas(): Promise<QuotaView[]> {
    const body = await this.handle<{ data: QuotaView[] }>(
      await this.http.get(`${this.base}/v1/quotas`, this.auth()),
    );
    return body.data ?? [];
  }

  async listConnections(): Promise<ConnectionView[]> {
    const body = await this.handle<{ data: ConnectionView[] }>(
      await this.http.get(`${this.base}/v1/connections`, this.auth()),
    );
    return body.data ?? [];
  }

  async testConnection(input: {
    providerId: string;
    connectionType?: "api" | "oauth";
    secret: string;
    baseUrl?: string;
  }): Promise<{ ok: boolean; quota?: unknown }> {
    return this.handle<{ ok: boolean; quota?: unknown }>(
      await this.http.post(`${this.base}/v1/connections/test`, JSON.stringify(input), {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }

  async createConnection(input: {
    providerId: string;
    label?: string;
    connectionType?: "api" | "oauth";
    secret: string;
  }): Promise<ConnectionView> {
    return this.handle<ConnectionView>(
      await this.http.post(`${this.base}/v1/connections`, JSON.stringify(input), {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }

  async getAntigravityAuthUrl(params?: { clientId?: string }): Promise<{ url: string; state: string; code_verifier: string }> {
    const qs = params?.clientId ? `?client_id=${encodeURIComponent(params.clientId)}` : "";
    return this.handle<{ url: string; state: string; code_verifier: string }>(
      await this.http.get(`${this.base}/v1/connections/oauth/antigravity/authorize${qs}`, this.auth()),
    );
  }

  async callbackAntigravityOAuth(input: {
    code: string;
    code_verifier: string;
    label?: string;
    client_id?: string;
    client_secret?: string;
  }): Promise<ConnectionView> {
    return this.handle<ConnectionView>(
      await this.http.post(`${this.base}/v1/connections/oauth/antigravity/callback`, JSON.stringify(input), {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }

  async updateConnection(
    id: string,
    input: { label?: string; secret?: string },
  ): Promise<ConnectionView> {
    return this.handle<ConnectionView>(
      await this.http.patch(`${this.base}/v1/connections/${id}`, JSON.stringify(input), {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }

  async deleteConnection(id: string): Promise<void> {
    return this.handle<void>(await this.http.delete(`${this.base}/v1/connections/${id}`, this.auth()));
  }

  async getFxRate(to = "BRL", from = "USD"): Promise<{ from: string; to: string; rate: number }> {
    return this.handle<{ from: string; to: string; rate: number }>(
      await this.http.get(`${this.base}/v1/fx/rate?from=${from}&to=${to}`, this.auth()),
    );
  }

  /** Revoke the current session server-side. */
  async logout(): Promise<void> {
    return this.handle<void>(await this.http.post(`${this.base}/auth/logout`, "", this.auth()));
  }

  /** History read via the GET alias (SPA compatibility, ADR-008). */
  async readHistory(params: { from?: string; to?: string } = {}): Promise<HistoryPoint[]> {
    const qs = new URLSearchParams();
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    const q = qs.toString();
    const url = `${this.base}/v1/history${q ? `?${q}` : ""}`;
    const body = await this.handle<{ data: HistoryPoint[] }>(
      await this.http.get(url, this.auth()),
    );
    return body.data ?? [];
  }

  async listSessions(): Promise<{ id: string; createdAt: string }[]> {
    const body = await this.handle<{ data: { id: string; createdAt: string }[] }>(
      await this.http.get(`${this.base}/v1/sessions`, this.auth()),
    );
    return body.data ?? [];
  }

  /** Rotate the current session; returns a fresh token (the old one dies). */
  async rotateSession(): Promise<{ token: string; expiresAt: string }> {
    return this.handle<{ token: string; expiresAt: string }>(
      await this.http.post(`${this.base}/v1/sessions/rotate`, "", this.auth()),
    );
  }

  // ---- Account security (E3) ----------------------------------------------

  async enrollTotp(currentPassword: string): Promise<{ secret: string; uri: string }> {
    return this.handle<{ secret: string; uri: string }>(
      await this.http.post(`${this.base}/auth/mfa/totp/enroll`, JSON.stringify({ currentPassword }), {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }

  async verifyTotp(code: string): Promise<{ ok: boolean; recoveryCodes: string[] }> {
    return this.handle<{ ok: boolean; recoveryCodes: string[] }>(
      await this.http.post(`${this.base}/auth/mfa/totp/verify`, JSON.stringify({ code }), {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }

  async disableTotp(currentPassword: string): Promise<void> {
    return this.handle<void>(
      await this.http.delete(`${this.base}/auth/mfa/totp`, {
        ...this.auth(),
        "X-Step-Up-Password": currentPassword,
      }),
    );
  }

  async regenerateRecoveryCodes(currentPassword: string): Promise<{ recoveryCodes: string[] }> {
    return this.handle<{ recoveryCodes: string[] }>(
      await this.http.post(`${this.base}/auth/mfa/recovery-codes/regenerate`, JSON.stringify({ currentPassword }), {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.handle<void>(
      await this.http.post(`${this.base}/auth/password/change`, JSON.stringify({ currentPassword, newPassword }), {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }

  // ---- User management (admin) --------------------------------------------

  async listUsers(): Promise<UserView[]> {
    const body = await this.handle<{ data: UserView[] }>(
      await this.http.get(`${this.base}/v1/admin/users`, this.auth()),
    );
    return body.data ?? [];
  }

  async updateUser(
    id: string,
    input: { role?: Role; isActive?: boolean },
  ): Promise<UserView> {
    return this.handle<UserView>(
      await this.http.patch(`${this.base}/v1/admin/users/${id}`, JSON.stringify(input), {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }

  async deleteUser(id: string): Promise<void> {
    return this.handle<void>(await this.http.delete(`${this.base}/v1/admin/users/${id}`, this.auth()));
  }

  /** LGPD purge: anonymize a user (step-up required). */
  async purgeUser(id: string, currentPassword: string): Promise<void> {
    return this.handle<void>(
      await this.http.post(`${this.base}/v1/admin/users/${id}/purge`, JSON.stringify({ currentPassword }), {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }

  /** Verify the audit hash chain (admin). */
  async verifyAudit(): Promise<{ ok: boolean; checked: number; brokenAt: string | null }> {
    return this.handle(
      await this.http.get(`${this.base}/v1/audit/verify`, this.auth()),
    );
  }

  async listInvites(): Promise<InviteView[]> {
    const body = await this.handle<{ data: InviteView[] }>(
      await this.http.get(`${this.base}/v1/admin/invites`, this.auth()),
    );
    return body.data ?? [];
  }

  async createInvite(input: {
    email: string;
    role: Role;
    expiresInHours?: number;
  }): Promise<{ invite: InviteView; inviteUrl: string }> {
    return this.handle<{ invite: InviteView; inviteUrl: string }>(
      await this.http.post(`${this.base}/v1/admin/invites`, JSON.stringify(input), {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }

  async revokeInvite(id: string): Promise<void> {
    return this.handle<void>(
      await this.http.delete(`${this.base}/v1/admin/invites/${id}`, this.auth()),
    );
  }

  // ---- Audit (admin/supervisor) -------------------------------------------

  async listAudit(params: {
    action?: string;
    targetType?: string;
    actor?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<{ data: AuditEventView[]; nextCursor: string | null }> {
    const qs = new URLSearchParams();
    if (params.action) qs.set("action", params.action);
    if (params.targetType) qs.set("target_type", params.targetType);
    if (params.actor) qs.set("actor", params.actor);
    if (params.cursor) qs.set("cursor", params.cursor);
    if (params.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    const body = await this.handle<{ data: AuditEventView[]; next_cursor: string | null }>(
      await this.http.get(`${this.base}/v1/audit${q ? `?${q}` : ""}`, this.auth()),
    );
    return { data: body.data ?? [], nextCursor: body.next_cursor };
  }

  // ---- System Settings & Operations (Admin) --------------------------------

  async getAdminSettings(): Promise<{
    collectIntervalMs: number;
    tls: {
      active: boolean;
      managedByProxy: boolean;
      certPath: string | null;
    };
    instance: {
      uptimeSeconds: number;
      nodeVersion: string;
    };
  }> {
    return this.handle(
      await this.http.get(`${this.base}/v1/admin/settings`, this.auth()),
    );
  }

  async updateAdminSettings(input: { collectIntervalMs: number }): Promise<{ ok: boolean; collectIntervalMs: number }> {
    return this.handle(
      await this.http.patch(`${this.base}/v1/admin/settings`, JSON.stringify(input), {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }

  async syncCollectorNow(): Promise<{
    ok: boolean;
    result: { collected: number; skipped: number; failed: number };
  }> {
    return this.handle(
      await this.http.post(`${this.base}/v1/admin/collector/sync-now`, "{}", {
        ...this.auth(),
        "Content-Type": "application/json",
      }),
    );
  }
}
