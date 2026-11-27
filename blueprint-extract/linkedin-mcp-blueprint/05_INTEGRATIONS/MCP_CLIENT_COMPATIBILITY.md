# MCP Client Compatibility Matrix

Track client, platform, version/date, remote/local transport, auth
requirements, tool discovery, tested operations, known limitations and
evidence. Treat every entry as unverified until tested.

## M6 entries (2026-11-27)

| Client | Platform / mode | Transport | Auth tested | Protocol tests | Live connector test | Evidence |
|---|---|---|---|---|---|---|
| Claude (official apps) | remote connector (URL) | Streamable HTTP | session cookie + bearer (401 paths verified) | ✅ 11/11 — initialize/session/tools-list/tools-call (status, unknown-tool, confirm-gate)/auth-rejection/error-shapes/reconnect | ❌ NOT performed (needs public HTTPS host) | `tests/integration/client-compat-claude.test.ts` |
| ChatGPT (official apps) | remote connector (URL, developer mode) | Streamable HTTP | session cookie + bearer (401 paths, logout lifecycle verified) | ✅ 10/10 — initialize/discovery w/ schemas/invocation w/ structured content/honest-disconnected-state/confirm-gate/session-invalidation/error-shapes/reconnect | ❌ NOT performed (needs public HTTPS host + connector-eligible plan) | `tests/integration/client-compat-chatgpt.test.ts` |

### Shared protocol facts verified on the wire (both suites)

1. `initialize` (legacy handshake) must NOT carry `MCP-Protocol-Version`
   (SDK rejects with `-32020` header/body disagreement).
2. Post-init modern-envelope requests require `MCP-Protocol-Version` +
   `Mcp-Method` (+ `Mcp-Name` for `tools/call`); the plain legacy shape
   (neither) is also accepted.
3. `mcp-session-id` is issued lazily by this SDK generation; clients must
   carry it once received; a fresh `initialize` after server restart
   re-establishes the session.
4. Authentication is enforced BEFORE protocol handling (401), for both
   missing and invalid credentials.
5. Confirmation gate (`linkedin_publish_post` `confirm:true`) is enforced
   at the schema boundary for every client — no client-side path can
   bypass it.
6. Error bodies are safe: no internal detail, no credential echo.

## Pre-M6 history

| Client | Status | Note |
|---|---|---|
| Generic MCP client (stdio, M1–M4) | ✅ 165-test regression | stdio transport + in-memory runtime |
| Console UI (in-repo, M5) | ✅ speaks MCP itself | `/admin`, session auth |

Live Claude / ChatGPT connector validation remains owner-side (checklists
in CLAUDE_INTEGRATION.md / CHATGPT_INTEGRATION.md §Live).
