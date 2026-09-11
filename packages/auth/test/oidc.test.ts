import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateOidcState,
  generatePkcePair,
  validateState,
  type OidcDiscovery,
} from "../src/oidc.js";
import type { HttpClient } from "@llm-quota/shared";

const discovery: OidcDiscovery = {
  authorizationEndpoint: "https://idp.example/authorize",
  tokenEndpoint: "https://idp.example/token",
  userinfoEndpoint: "https://idp.example/userinfo",
};

const config = {
  issuer: "https://idp.example",
  clientId: "client",
  clientSecret: "secret",
  redirectUri: "https://app.example/callback",
};

describe("OIDC", () => {
  it("generates a PKCE verifier + S256 challenge", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toBe(challenge);
  });

  it("generates and validates opaque state", () => {
    const state = generateOidcState();
    expect(validateState(state, state)).toBe(true);
    expect(validateState(state, "other")).toBe(false);
  });

  it("builds an authorization URL with PKCE + state params", () => {
    const url = buildAuthorizationUrl(
      { ...config, discovery },
      { state: "s1", codeChallenge: "ch" },
    );
    expect(url.hostname).toBe("idp.example");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/callback");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges a code for tokens", async () => {
    const http: HttpClient = {
      post: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "at",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rt",
          scope: "openid",
        }),
        text: async () => "",
      }),
      get: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
    };
    const tokens = await exchangeCodeForTokens(config, discovery, "code", "verifier", http);
    expect(tokens.access_token).toBe("at");
    expect(tokens.refresh_token).toBe("rt");
  });

  it("throws when token exchange fails", async () => {
    const http: HttpClient = {
      post: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
        text: async () => "",
      }),
      get: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
    };
    await expect(exchangeCodeForTokens(config, discovery, "bad", "verifier", http)).rejects.toThrow(
      /Token exchange failed/,
    );
  });
});
