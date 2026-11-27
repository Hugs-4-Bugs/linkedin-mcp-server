# Authentication Architecture

Separate MCP host/client authentication from LinkedIn OAuth identity. The server must not confuse a user's identity at the MCP service with their LinkedIn identity. Use standard, documented OAuth flows, state/nonce protections as applicable, redirect URI allowlists, PKCE where applicable, CSRF protections, strict token audience/issuer validation, secure token storage, revocation/disconnect handling, and scoped authorization. Validate host/client requirements at implementation time.

Do not assume one OAuth flow is compatible with both ChatGPT and Claude. Build compatibility adapters/configuration only after their requirements are verified.

## M5 implemented model (2026-11-27, ADR-019)

Three authentication domains, cleanly separated:

1. **LinkedIn OAuth (3LO)** — unchanged from M2: state-CSRF, single-use codes, sealed tokens; now persisted (`oauth_states`, `linkedin_tokens` — atomic single-use consume survives restarts).
2. **Console/app users** — scrypt password verification against `users`; login issues an opaque session token (HttpOnly+SameSite=Lax cookie; Secure in staging/production) whose SHA-256 digest is stored with a per-session CSRF token digest; logout revokes the row. First user via `src/scripts/bootstrapAdmin.ts`.
3. **API clients** — bearer `lkm_…` tokens (digest at rest) for non-UI MCP clients; resolve to one tenant; revocable.

The authenticated tenant (never a caller-supplied identifier) travels to the tool layer via AsyncLocalStorage and is re-entered around the SDK handler chain. Production startup rejects `AUTH_MODE=mock` and `OAUTH_PROVIDER=mock`. stdio mode has no authentication (local tenant) by design.
