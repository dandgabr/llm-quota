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
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<
  Omit<HttpResponse, "json" | "text"> & {
    json(): Promise<unknown>;
    text(): Promise<string>;
  }
>;

/** Global fetch impl, read via `unknown` cast (ES2022 lib has no DOM fetch). */
const defaultFetch = (globalThis as unknown as { fetch?: FetchFn }).fetch;

/** Real `fetch`-backed HttpClient (Node >= 22 global fetch). */
export const createFetchHttpClient = (fetchFn?: FetchFn): HttpClient => {
  const doFetch = fetchFn ?? defaultFetch!;
  const handle = async (res: Awaited<ReturnType<FetchFn>>): Promise<HttpResponse> => ({
    status: res.status,
    ok: res.ok,
    json: () => res.json(),
    text: () => res.text(),
  });
  return {
    async get(url, headers) {
      return handle(await doFetch(url, { method: "GET", headers }));
    },
    async post(url, body, headers) {
      const init: { method?: string; headers?: Record<string, string>; body?: string } = {
        method: "POST",
        headers,
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
