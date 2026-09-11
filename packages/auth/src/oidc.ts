import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OIDC abstraction (ADR-001). Supports authorization-code flow with PKCE and
 * `state`, pinned `redirect_uri`, and a `client_id`/`client_secret` (the secret
 * is encrypted at rest; it is decrypted only in memory). HTTP is injected so
 * tests run offline. Token parsing is kept to the identity claims llm-quota
 * needs; full JWT validation is out of scope for v1 (transport is TLS 1.3).
 */

export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  /** Decrypted client secret (in-memory only; never logged). */
  clientSecret: string;
  /** Pinned redirect URI — the only accepted callback. */
  redirectUri: string;
  /** Discovery URL for well-known config (optional override). */
  discoveryUrl?: string;
}

export interface OidcTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export interface OidcUserInfo {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

/** Minimal HTTP client the OIDC flow uses (matches providers `HttpClient` shape). */
export interface HttpPostClient {
  post(
    url: string,
    body: URLSearchParams,
    headers?: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

/** PKCE code pair generator (S256) — the verifier + derived challenge. */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Generate an opaque `state` value to bind the callback. */
export function generateOidcState(): string {
  return randomBytes(16).toString("base64url");
}

/** Validate that `state` in the callback matches the one we issued. */
export function validateState(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Build the authorization-code + PKCE + state authorization URL. */
export function buildAuthorizationUrl(
  config: OidcClientConfig & { discovery: OidcDiscovery },
  request: { state: string; codeChallenge: string; nonce?: string },
): URL {
  const { discovery, clientId, redirectUri } = { ...config };
  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (request.nonce) url.searchParams.set("nonce", request.nonce);
  return url;
}

export interface OidcDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint?: string;
}

/** Fetch the discovery document; accepts a pre-resolved one for offline tests. */
export async function fetchDiscovery(
  config: OidcClientConfig,
  http?: {
    get(url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  },
): Promise<OidcDiscovery> {
  const url = config.discoveryUrl ?? `${new URL(config.issuer).origin}/.well-known/openid-configuration`;
  const client = http ?? {
    get: async (u: string) => {
      const res = await globalThis.fetch(u);
      return { ok: res.ok, status: res.status, json: () => res.json() };
    },
  };
  const res = await client.get(url);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const body = (await res.json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    userinfo_endpoint?: string;
  };
  return {
    authorizationEndpoint: body.authorization_endpoint,
    tokenEndpoint: body.token_endpoint,
    userinfoEndpoint: body.userinfo_endpoint,
  };
}

/**
 * Exchange an authorization code for tokens (PKCE + client_secret_basic).
 * Validates the response shape; the `state`/`nonce` are validated by the caller
 * before this call. Returns the token set (never logged).
 */
export async function exchangeCodeForTokens(
  config: OidcClientConfig,
  discovery: OidcDiscovery,
  code: string,
  codeVerifier: string,
  http?: HttpPostClient,
): Promise<OidcTokenResponse> {
  const client = http ?? {
    post: async (url: string, body: URLSearchParams) => {
      const res = await globalThis.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      return { ok: res.ok, status: res.status, json: () => res.json() };
    },
  };
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
    client_id: config.clientId,
  });
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await client.post(discovery.tokenEndpoint, params, {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const token = (await res.json()) as OidcTokenResponse;
  if (!token.access_token) throw new Error("Token exchange response missing access_token");
  if (token.token_type && !/^Bearer$/i.test(token.token_type)) {
    throw new Error(`Unexpected token_type: ${token.token_type}`);
  }
  return token;
}

/**
 * Fetch the userinfo claims (sub/email/name) for an access token. Uses the
 * discovery `userinfoEndpoint` when available; never logs the token.
 */
export async function fetchUserInfo(
  accessToken: string,
  discovery: OidcDiscovery,
  http?: {
    get(url: string, headers?: Record<string, string>): Promise<{
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
    }>;
  },
): Promise<OidcUserInfo> {
  if (!discovery.userinfoEndpoint) {
    throw new Error("OIDC discovery has no userinfo_endpoint");
  }
  const client = http ?? {
    get: async (url: string, headers?: Record<string, string>) => {
      const res = await globalThis.fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, ...headers },
      });
      return { ok: res.ok, status: res.status, json: () => res.json() };
    },
  };
  const res = await client.get(discovery.userinfoEndpoint, {
    Authorization: `Bearer ${accessToken}`,
  });
  if (!res.ok) throw new Error(`Userinfo fetch failed (${res.status})`);
  const body = (await res.json()) as OidcUserInfo;
  if (!body.sub) throw new Error("Userinfo response missing sub");
  return body;
}
