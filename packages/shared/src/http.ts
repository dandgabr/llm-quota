/**
 * Unified HTTP client for llm-quota.
 *
 * A single `HttpClient` (with `get` and `post`) is shared by the provider
 * connectors (ADR-007) and the OIDC/auth flows so the monorepo has one contract
 * (ADR-009 consequence). Production uses global `fetch` (Node >= 22); tests
 * inject an in-memory stub.
 */

/** Minimal HTTP response surface the clients rely on. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Minimal HTTP client used across connectors and OIDC. */
export interface HttpClient {
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
  post(
    url: string,
    body: URLSearchParams | string,
    headers?: Record<string, string>,
  ): Promise<HttpResponse>;
}

/** The fetch-like function injected into `createFetchHttpClient`. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<
  Omit<HttpResponse, "json" | "text"> & {
    json(): Promise<unknown>;
    text(): Promise<string>;
  }
>;

/** Global fetch impl, read via `unknown` cast (ES2022 lib has no DOM fetch). */
const defaultFetch = (globalThis as unknown as { fetch?: FetchFn }).fetch;

/** Default per-request timeout (ms) so a hung provider never stalls a caller. */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/** Real `fetch`-backed HttpClient (Node >= 22 global fetch).
 *
 * Every request carries an `AbortSignal.timeout` (default 10 s) so a hung
 * upstream connection fails fast instead of stalling a collector pass or an
 * OIDC round-trip for undici's default 300 s header window.
 */
export const createFetchHttpClient = (
  fetchFn?: FetchFn,
  timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
): HttpClient => {
  const doFetch = fetchFn ?? defaultFetch!;
  const handle = async (res: Awaited<ReturnType<FetchFn>>): Promise<HttpResponse> => ({
    status: res.status,
    ok: res.ok,
    json: () => res.json(),
    text: () => res.text(),
  });
  return {
    async get(url, headers) {
      return handle(await doFetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) }));
    },
    async post(url, body, headers) {
      const init: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        signal?: AbortSignal;
      } = {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (body instanceof URLSearchParams) {
        init.body = body.toString();
      } else if (typeof body === "string") {
        init.body = body;
      }
      return handle(await doFetch(url, init));
    },
  };
};
