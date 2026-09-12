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

export interface QuotaView {
  id: string;
  connectionId: string;
  kind: "percent" | "credits";
  usedPercent: number;
  remainingPercent: number;
  usedAmount?: number;
  remainingAmount?: number;
  currency?: string;
  resetAt?: string;
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
    private readonly token: string,
    private readonly opts: ApiOptions = {},
  ) {
    this.http = opts.http ?? createFetchHttpClient();
    this.base = opts.baseUrl ?? resolveApiBaseUrl(import.meta.env as Record<string, string | undefined>);
  }

  /** Authorization header for every request. */
  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  /** Shared response handling: 401 hook, then throw a typed `ApiError`. */
  private async handle<T>(res: HttpResponse): Promise<T> {
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

  async deleteConnection(id: string): Promise<void> {
    return this.handle<void>(await this.http.delete(`${this.base}/v1/connections/${id}`, this.auth()));
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
}
