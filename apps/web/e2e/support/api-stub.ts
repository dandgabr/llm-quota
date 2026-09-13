/**
 * Deterministic API stub for the Playwright usability suite.
 *
 * Mirrors the Hono API contract (ADR-008) with seeded fixtures so browser
 * journeys are hermetic — no live Postgres. `POST /__/reset` restores the base
 * seed between tests.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface Quota {
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
interface Connection {
  id: string;
  providerKey: string;
  label: string;
  connectionType: "api" | "oauth";
  status: "ok" | "error" | "unconfigured";
  createdAt: string;
}
interface HistoryPoint {
  windowKey: string;
  spentAmount: number;
  currency: string;
  granularity: "daily" | "weekly" | "monthly";
}
interface UserView {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: "user" | "supervisor" | "admin";
  locale: string;
  isActive: boolean;
  hasPassword: boolean;
  createdAt: string;
}
interface InviteView {
  id: string;
  email: string;
  role: "user" | "supervisor" | "admin";
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const TOKENS: Record<string, string> = {
  "tok-user": "user",
  "tok-supervisor": "supervisor",
  "tok-admin": "admin",
};

let state: {
  quotas: Quota[];
  connections: Connection[];
  history: HistoryPoint[];
  users: UserView[];
  invites: InviteView[];
  setupRequired: boolean;
};

function reset() {
  state = {
    quotas: [
      {
        id: "q1",
        connectionId: "conn-1",
        kind: "percent",
        usedPercent: 72,
        remainingPercent: 28,
        resetAt: "2026-10-01T00:00:00Z",
      },
      {
        id: "q2",
        connectionId: "conn-2",
        kind: "credits",
        usedPercent: 25,
        remainingPercent: 75,
        usedAmount: 12.5,
        remainingAmount: 37.5,
        currency: "USD",
      },
    ],
    connections: [
      {
        id: "conn-1",
        providerKey: "ollama-claude/api",
        label: "seeded-provider",
        connectionType: "api",
        status: "ok",
        createdAt: "2026-09-01T00:00:00Z",
      },
    ],
    history: [
      { windowKey: "daily:2026-09-09", spentAmount: 1.2, currency: "USD", granularity: "daily" },
      { windowKey: "daily:2026-09-10", spentAmount: 3.4, currency: "USD", granularity: "daily" },
      { windowKey: "weekly:2026-09-07", spentAmount: 9.1, currency: "USD", granularity: "weekly" },
      { windowKey: "monthly:2026-09-01", spentAmount: 21.7, currency: "USD", granularity: "monthly" },
    ],
    users: [
      {
        id: "u-admin",
        email: "admin@test.local",
        firstName: "Ada",
        lastName: "Admin",
        role: "admin",
        locale: "en",
        isActive: true,
        hasPassword: true,
        createdAt: "2026-09-01T00:00:00Z",
      },
      {
        id: "u-user",
        email: "user@test.local",
        firstName: "Uma",
        lastName: null,
        role: "user",
        locale: "en",
        isActive: true,
        hasPassword: false,
        createdAt: "2026-09-02T00:00:00Z",
      },
    ],
    invites: [],
  };
  // Setup defaults to "not required" so existing journeys skip /setup. A test
  // can flip it via POST /__/setup-required.
  state.setupRequired = process.env.STUB_SETUP_REQUIRED === "1";
}
reset();

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,QUERY",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolveBody(data));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:3100");
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  // CORS preflight (the SPA origin differs from this stub).
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,QUERY",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  if (url.pathname === "/health") return json(res, 200, { ok: true });
  if (url.pathname === "/__/reset" && req.method === "POST") {
    reset();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/__/empty" && req.method === "POST") {
    state.quotas = [];
    state.connections = [];
    state.history = [];
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/__/setup-required" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}") as { required?: boolean };
    state.setupRequired = body.required ?? true;
    return json(res, 200, { ok: true, required: state.setupRequired });
  }

  // ---- Public onboarding --------------------------------------------------
  if (url.pathname === "/auth/setup/status") {
    return json(res, 200, { required: state.setupRequired });
  }
  if (url.pathname === "/auth/setup" && req.method === "POST") {
    const parsed = JSON.parse((await readBody(req)) || "{}") as { token?: string; email?: string };
    if (parsed.token !== "valid-setup-token") {
      return json(res, 403, { type: "https://api.llm-quota.dev/errors/forbidden", title: "Forbidden", status: 403 });
    }
    state.setupRequired = false;
    return json(res, 201, {
      token: "tok-admin",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: {
        id: "u-owner",
        email: parsed.email ?? "owner@test.local",
        firstName: null,
        lastName: null,
        role: "admin",
        locale: "en",
        isActive: true,
        hasPassword: true,
        createdAt: new Date().toISOString(),
      },
    });
  }
  if (url.pathname === "/auth/login" && req.method === "POST") {
    const parsed = JSON.parse((await readBody(req)) || "{}") as { email?: string; password?: string };
    if (parsed.email === "mfa@test.local") {
      return json(res, 200, { status: "mfa_required", methods: ["totp", "recovery"], challenge: "chal-1" });
    }
    if (parsed.password !== "correct-password") {
      return json(res, 401, { type: "https://api.llm-quota.dev/errors/unauthorized", title: "Unauthorized", status: 401 });
    }
    return json(res, 200, {
      token: "tok-user",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: { id: "u-user", email: parsed.email, firstName: null, lastName: null, role: "user", locale: "en", isActive: true, hasPassword: true, createdAt: new Date().toISOString() },
    });
  }
  if (url.pathname === "/auth/login/mfa" && req.method === "POST") {
    const parsed = JSON.parse((await readBody(req)) || "{}") as { code?: string };
    if (parsed.code !== "123456") {
      return json(res, 401, { type: "https://api.llm-quota.dev/errors/unauthorized", title: "Unauthorized", status: 401 });
    }
    return json(res, 200, {
      token: "tok-user",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: { id: "u-user", email: "mfa@test.local", firstName: null, lastName: null, role: "user", locale: "en", isActive: true, hasPassword: true, createdAt: new Date().toISOString() },
    });
  }
  if (url.pathname === "/auth/invites/accept" && req.method === "POST") {
    const parsed = JSON.parse((await readBody(req)) || "{}") as { token?: string };
    if (parsed.token !== "valid-invite-token") {
      return json(res, 410, { type: "https://api.llm-quota.dev/errors/invite-expired", title: "Gone", status: 410 });
    }
    return json(res, 201, {
      token: "tok-user",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: {
        id: "u-invitee",
        email: "invitee@test.local",
        firstName: null,
        lastName: null,
        role: "user",
        locale: "en",
        isActive: true,
        hasPassword: true,
        createdAt: new Date().toISOString(),
      },
    });
  }

  const role = TOKENS[token];

  if (url.pathname === "/v1/sessions") {
    if (!role) return json(res, 401, { title: "Unauthorized", status: 401 });
    return json(res, 200, {
      data: [{ id: "sess-1", createdAt: "2026-09-11T00:00:00Z" }],
    });
  }
  if (url.pathname === "/v1/connections/test" && req.method === "POST") {
    if (!role) return json(res, 401, { title: "Unauthorized", status: 401 });
    const body = await readBody(req);
    const parsed = JSON.parse(body || "{}") as { secret?: string; providerId?: string };
    if (!parsed.secret || !parsed.providerId) {
      return json(res, 400, { title: "Bad Request", status: 400 });
    }
    if (parsed.secret.includes("invalid")) {
      return json(res, 400, { title: "Bad Request", detail: "Invalid API key", status: 400 });
    }
    return json(res, 200, { ok: true, quota: { kind: "percent", usedPercent: 15, remainingPercent: 85 } });
  }
  if (url.pathname === "/v1/quotas" || url.pathname === "/v1/connections") {
    if (!role) return json(res, 401, { title: "Unauthorized", status: 401 });
    if (req.method === "POST") {
      const body = await readBody(req);
      const parsed = JSON.parse(body || "{}") as {
        providerId?: string;
        label?: string;
        secret?: string;
      };
      if (!parsed.secret || !parsed.providerId) {
        return json(res, 400, { title: "Bad Request", status: 400 });
      }
      const conn: Connection = {
        id: `conn-${Date.now()}`,
        providerKey: parsed.providerId,
        label: parsed.label ?? parsed.providerId,
        connectionType: "api",
        status: "ok",
        createdAt: new Date().toISOString(),
      };
      state.connections.push(conn);
      return json(res, 201, conn);
    }
    const key = url.pathname === "/v1/quotas" ? "quotas" : "connections";
    return json(res, 200, { data: state[key as "quotas" | "connections"], has_more: false, next_cursor: null });
  }
  if (url.pathname === "/v1/history") {
    if (!role) return json(res, 401, { title: "Unauthorized", status: 401 });
    return json(res, 200, { data: state.history, has_more: false, next_cursor: null });
  }
  if (url.pathname === "/v1/quotas/summary") {
    if (!role) return json(res, 401, { title: "Unauthorized", status: 401 });
    if (role === "user") return json(res, 403, { title: "Forbidden", status: 403 });
    return json(res, 200, { summary: {} });
  }

  // ---- User management (Phase A) ------------------------------------------
  if (url.pathname === "/v1/admin/users") {
    if (!role) return json(res, 401, { title: "Unauthorized", status: 401 });
    if (role !== "admin") return json(res, 403, { title: "Forbidden", status: 403 });
    return json(res, 200, { data: state.users, has_more: false, next_cursor: null });
  }
  if (url.pathname.startsWith("/v1/admin/users/")) {
    if (role !== "admin") return json(res, 403, { title: "Forbidden", status: 403 });
    const id = url.pathname.split("/").pop();
    const user = state.users.find((u) => u.id === id);
    if (!user) return json(res, 404, { type: "https://api.llm-quota.dev/errors/not-found", title: "Not Found", status: 404 });
    if (req.method === "PATCH") {
      const parsed = JSON.parse((await readBody(req)) || "{}") as Partial<UserView>;
      Object.assign(user, parsed);
      return json(res, 200, user);
    }
    if (req.method === "DELETE") {
      if (user.role === "admin" && state.users.filter((u) => u.role === "admin" && u.isActive).length <= 1) {
        return json(res, 409, {
          type: "https://api.llm-quota.dev/errors/last-admin",
          title: "Conflict",
          status: 409,
        });
      }
      state.users = state.users.filter((u) => u.id !== id);
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      return res.end();
    }
  }
  if (url.pathname === "/v1/admin/invites") {
    if (role !== "admin") return json(res, 403, { title: "Forbidden", status: 403 });
    if (req.method === "POST") {
      const parsed = JSON.parse((await readBody(req)) || "{}") as { email: string; role: "user" | "supervisor" | "admin" };
      const invite: InviteView = {
        id: `inv-${Date.now()}`,
        email: parsed.email,
        role: parsed.role ?? "user",
        expiresAt: "2026-09-15T00:00:00Z",
        acceptedAt: null,
        revokedAt: null,
        createdAt: new Date().toISOString(),
      };
      state.invites.push(invite);
      return json(res, 201, { invite, inviteUrl: `/invite#token=stub-${invite.id}` });
    }
    return json(res, 200, { data: state.invites, has_more: false, next_cursor: null });
  }
  if (url.pathname.startsWith("/v1/admin/invites/") && req.method === "DELETE") {
    if (role !== "admin") return json(res, 403, { title: "Forbidden", status: 403 });
    const id = url.pathname.split("/").pop();
    state.invites = state.invites.filter((i) => i.id !== id);
    res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
    return res.end();
  }

  if (url.pathname === "/v1/audit") {
    if (!role) return json(res, 401, { title: "Unauthorized", status: 401 });
    if (role === "user") return json(res, 403, { title: "Forbidden", status: 403 });
    return json(res, 200, {
      data: [
        {
          id: "ev-1",
          occurredAt: "2026-09-11T12:00:00Z",
          actorUserId: "u-admin",
          actorRole: "admin",
          action: "user.role_changed",
          targetType: "user",
          targetId: "u-user",
          metadata: { role: "supervisor" },
          requestId: "req-1",
        },
      ],
      has_more: false,
      next_cursor: null,
    });
  }

  json(res, 404, { title: "Not Found", status: 404 });
});

server.listen(3100, "127.0.0.1", () => console.log("[api-stub] on http://127.0.0.1:3100"));
