# Claude Integration (M6, 2026-11-27)

How to connect the official Claude client apps to this LinkedIn MCP server
over remote Streamable HTTP. **Status line up front:**

- ✅ **Automated protocol-level tests** — VERIFIED in this repo
  (`tests/integration/client-compat-claude.test.ts`, 11/11, run in CI):
  initialize handshake, session behavior, tool discovery, tool invocation,
  auth rejection, error shapes, reconnect-after-restart.
- ❌ **Live Claude connector test** — NOT performed yet. It requires a
  public HTTPS host with real credentials. Owner-side: follow §Live
  validation checklist after staging deployment.

## How Claude connects (current official mechanism)

Claude connects to remote MCP servers via **Connectors / custom connectors**:

- Claude web/desktop supports remote MCP servers over **Streamable HTTP**
  (URL-based) and OAuth-protected connectors. In Claude: **Settings →
  Connectors → Add custom connector** (or the newer "Apps & Connectors"
  surface), paste the server URL, and authenticate if required.
- Claude Code (CLI) supports remote servers via
  `claude mcp add --transport http <name> <url> [headers]` (bearer/API-token
  auth is configurable via headers).
- Local stdio servers are supported in Claude Desktop/Code via config —
  but this project's remote deployment targets the URL connector path.

**This server's connector parameters:**

| Field | Value |
|---|---|
| Server URL | `https://<your-staging-host>/mcp` |
| Auth | HTTP cookie session (login via `/admin`) or Bearer API-token header `Authorization: Bearer lkm_…` |
| Protocol | Streamable HTTP (JSON-RPC over POST; SSE responses) |

Note on OAuth connectors: Claude's connector OAuth flow expects the server
to implement the MCP **OAuth 2.0** authorization flow. This server currently
authenticates with **its own session/API-token layer** (M5, ADR-019); the
LinkedIn OAuth inside is the *content* connection, not the *connector*
auth. If Claude's connector screen demands the MCP OAuth flow for custom
connectors on your plan, use the Bearer API-token connector mode (Claude
supports custom-header auth for connectors) until MCP-side OAuth is
implemented (tracked as future work; see INTEGRATION_LIMITATIONS.md).

## Verified protocol contract (what the automated tests assert)

1. `initialize` is the legacy handshake — it must be sent **without** the
   `MCP-Protocol-Version` header (the SDK rejects the mismatch, code
   `-32020`).
2. Post-initialize requests in the modern envelope need BOTH the
   `MCP-Protocol-Version` header AND the `Mcp-Method` header (and
   `Mcp-Name` for `tools/call`) — or, in the legacy shape, neither.
3. `mcp-session-id` is issued lazily; carry it on subsequent requests once
   received; a new `initialize` after a server restart works immediately.
4. Unauthenticated calls get HTTP 401 before protocol handling; invalid
   bearer gets 401.
5. Unknown tools are rejected safely (JSON-RPC error or tool-level
   `isError`), never a crash; error bodies never leak internals.
6. The full tool catalog (9 tools) is discovered with strict schemas;
   `status` returns structured content.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| 401 on connect | No/invalid session cookie or bearer token. Log in at `/admin` first, or issue an API token and configure it as a custom header. |
| `-32020 header/body disagree` on initialize | You sent `MCP-Protocol-Version` WITH initialize. Remove it from the initialize request (legacy handshake rule). |
| `-32020` on tools/call | Body envelope (`_meta` protocolVersion) present but `Mcp-Method`/`Mcp-Name` headers missing — add them, or use the plain legacy shape with neither. |
| `-32602 missing _meta` | `MCP-Protocol-Version` header set but body has no `_meta` envelope. Either add the envelope or drop the header. |
| Tools listed but calls fail with `not-connected` | Expected until LinkedIn is connected: run `linkedin_connect` (or use the console's Connect button) for that tenant. |
| Publish refused with `confirm` error | Working as designed: `linkedin_publish_post` requires `confirm: true` (schema-level gate, ADR-016). |
| Session lost after server restart | Server restarts invalidate in-flight MCP sessions; clients re-run `initialize` (Claude reconnects automatically). |
| 413 payload too large | Request exceeded `MAX_BODY_MIB` (default 1 MiB). |

## Live validation checklist (owner-side, after staging deploy)

1. Deploy staging per `deploy/README.md` (Caddy TLS, Postgres, bootstrapAdmin).
2. Run `deploy/staging-smoke.sh https://<host>` — all checks must pass.
3. In Claude: Settings → Connectors → add custom connector →
   `https://<host>/mcp` + bearer API-token header (issue via console/API).
4. Verify in-chat: the connector's tools are listed (9 tools).
5. Ask Claude to call the `status` tool → expect server identity JSON.
6. Complete a LinkedIn connection via `/admin` (OAuth consent) for the
   tenant Claude connects as.
7. Ask Claude for `linkedin_get_my_profile` → real profile data.
8. Ask Claude to draft a post (`linkedin_draft_post`) → validation result.
9. Attempt a publish WITHOUT explicit confirmation → expect refusal
   (confirm gate).
10. Deliberately publish WITH confirmation on a test account → verify the
    post appears on LinkedIn and the URN is reported.
11. Restart the server; confirm Claude reconnects transparently.
12. Record the result in `05_INTEGRATIONS/MCP_CLIENT_COMPATIBILITY.md`
    (client, platform, date, version, evidence, limitations).
