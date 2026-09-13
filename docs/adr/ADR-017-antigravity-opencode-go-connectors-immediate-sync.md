# ADR-017: Antigravity and OpenCode Go Connectors with Immediate Sync

**Status:** accepted (Phase 3 extension — connectors & immediate sync)

## Context

The initial provider integration supported Ollama Claude and OpenRouter. However, developer subscription models in modern workflows rely heavily on:
1. **Google Antigravity / Gemini Code Assist**: Subscription with multiple model quotas (e.g. Gemini Models vs Claude & GPT Models), OAuth 2.0 with PKCE and token refresh against Google's token endpoint (`https://oauth2.googleapis.com/token`), and sliding time windows (`session`, `weekly`).
2. **OpenCode Go**: API key-based subscription provider featuring sliding time windows (`session`, `weekly`, and `monthly`).

Furthermore, previously all quota collection was bound to the periodic scheduler loop (running every `COLLECT_INTERVAL_MS`, default 60s). When a user added or edited a connection, the UI did not show current quota data until the next collector tick, degrading user experience.

## Decision

1. **Concrete Connectors (`packages/providers/connectors/`)**:
   - `@llm-quota/connector-antigravity` (`antigravity/oauth`): OAuth 2.0 PKCE flow, automated token refresh via `saveSecret` callback, quota metrics extracted from Google Cloud Code internal endpoints (`/v1internal:loadCodeAssist` and `/v1internal:fetchAvailableModels`) or `/v1/quota`. Supports multi-model group breakdown (`modelGroups`) exposing separate sliding quotas for Gemini Models and Claude/GPT Models.
   - `@llm-quota/connector-opencode-go` (`opencode-go/api`): API key authentication, supports sliding windows `session`, `weekly`, and `monthly`. Validates keys through `/zen/go/v1/quota` or fallback completion ping.
2. **Taxonomy & Quota Windows**:
   - Clarified distinction between sliding-window subscriptions (`quotaType: "sliding_window"`, standard windows `["session", "weekly"]`, with optional `"monthly"`) and credit balances (`quotaType: "credits"`, snapshot window `["lifetime"]`).
   - `daily` is preserved for historical aggregation in Postgres, not as an active sliding quota window.
3. **Immediate Event-Driven Synchronization (`triggerCollectorSync`)**:
   - Creating or updating connections (`POST /v1/connections`, `PATCH /v1/connections/:id`, and `POST /v1/connections/oauth/antigravity/callback`) triggers `triggerCollectorSync(connectionId)`.
   - The trigger zeroes out `lastCollectedAt` to bypass debouncing and immediately queries upstream providers.
   - The HTTP route races the collector pass with a 1.5s timeout: fast responses are committed before the response returns to the client, while slower upstream requests finish asynchronously without blocking the client.
4. **Dashboard Model Grouping**:
   - The dashboard and `QuotaDonut` components support granular rendering of model groups when provided by the snapshot (`modelGroups`).

## Consequences

- **Easier**: Immediate feedback upon connection creation; native support for Google Antigravity OAuth and OpenCode Go without third-party proxy daemons.
- **Harder**: OAuth token refresh lifecycle must be coordinated between the collector and database envelope encryption; upstream rate limits require careful retry handling.
- **Amends**: ADR-007 (extends connector framework with `modelGroups` and OAuth credential handling).
