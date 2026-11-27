# ChatGPT Integration (M6, 2026-11-27)

How to connect ChatGPT to this LinkedIn MCP server. **Status line up front:**

- ✅ **Automated protocol-level tests** — VERIFIED in this repo
  (`tests/integration/client-compat-chatgpt.test.ts`, 10/10, run in CI):
  initialize handshake, tool discovery with strict schemas, tool invocation
  with structured content, honest disconnected state, confirmation-gate
  enforcement, auth rejection, session invalidation, error shapes, logout
  lifecycle, reconnect-after-restart.
- ❌ **Live ChatGPT connector test** — NOT performed yet. It requires a
  public HTTPS host and a ChatGPT plan with connector support. Owner-side:
  §Live validation checklist.

## How ChatGPT connects (current official mechanism)

ChatGPT's MCP support runs through **Connectors** (developer mode):

- **Apps & Connectors / Developer mode**: ChatGPT (plus higher plans and
  workspaces with connectors enabled) can add remote MCP servers via URL
  in the connectors/developer settings — often called "Apps & Connectors →
  Developer mode → Add connector". Availability varies by plan, workspace
  type and region; treat any specific menu path as unverified until the
  owner walks it live.
- **URL-based, Streamable HTTP**: no local command/stdio support — ChatGPT
  only connects to remote servers it can reach over HTTPS.
- **Authentication**: OAuth 2.0 for first-class connectors is the platform
  default; for custom/developer connectors, bearer-token header auth is the
  workable path today. This server's session/API-token layer (M5, ADR-019)
  fits the bearer path: configure the connector with the
  `Authorization: Bearer lkm_…` API token. MCP-side OAuth is future work
  (see INTEGRATION_LIMITATIONS.md).

**Connector parameters:**

| Field | Value |
|---|---|
| Server URL | `https://<your-staging-host>/mcp` |
| Auth | Bearer API token (`Authorization: Bearer lkm_…`), issued per tenant |
| Protocol | Streamable HTTP |

## Supported plan / client limitations (documented, not invented)

- Remote MCP connectors are a **paid-plan / workspace feature** in
  ChatGPT; free tiers generally cannot add custom remote connectors.
- The tools surface appears to the model; ChatGPT decides when to call
  tools — publishing to LinkedIn still passes through the same
  `confirm:true` gate (no client can bypass it; enforced in this repo's
  schema).
- ChatGPT does not run local commands: stdio transport is irrelevant
  there (stdio remains for local/Claude-Desktop-style clients).
- Tool-call sizes are bounded by the server's 1 MiB body cap.
- Exact menu names and per-plan availability shift over time — the
  §Live checklist captures what the owner actually observes.

## Verified protocol contract (what the automated tests assert)

Identical surface to the Claude suite (shared Streamable HTTP contract):
initialize without version header; modern envelope requests carrying
`MCP-Protocol-Version` + `Mcp-Method` (+ `Mcp-Name` for tools/call) or the
plain legacy shape; 401 before protocol handling when unauthenticated;
logout revokes the cookie session and MCP rejects it immediately;
reconnect after restart works. ChatGPT-specific framing in this suite:
structured content renderability (schemas present on every tool) and the
honest disconnected state (`linkedin_status` returns `connected:false`
with no fake profile data).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Connector add fails / no connector option | Plan or workspace does not have connector/developer-mode support. Check the plan's connectors availability. |
| 401 during connect | Bearer token missing/revoked. Issue a fresh API token for that tenant and configure the header. |
| `-32020 header/body disagree` | Same SDK rules as the Claude doc: initialize must not carry `MCP-Protocol-Version`; post-init modern requests must carry `Mcp-Method` (+`Mcp-Name`). ChatGPT's own client handles this — relevant only for custom tooling. |
| Tools listed but calls fail `not-connected` | LinkedIn not connected for the tenant yet — connect via `/admin` first. |
| Publish refused with `confirm` error | By design (ADR-016). Ask the model to include the explicit confirmation. |
| Session drops after server restart | Client re-initializes automatically; verify the tools list again. |

## Live validation checklist (owner-side, after staging deploy)

1. Deploy staging per `deploy/README.md`; run the smoke script green.
2. Confirm the ChatGPT account/plan has connectors (Apps & Connectors in
   settings; Developer mode for custom connectors).
3. Issue an API token for the deployment tenant (keep it scoped to that
   tenant).
4. Add the connector: URL `https://<host>/mcp`, auth header with the
   bearer token.
5. In a new chat, verify the LinkedIn tools appear to the model.
6. Ask for the server `status` tool → identity JSON.
7. Connect LinkedIn via `/admin` for that tenant.
8. Ask for `linkedin_get_my_profile` → real profile.
9. Ask to draft a post → validation result; ask to publish WITHOUT
   confirmation → refusal (gate working).
10. Publish WITH explicit confirmation on a test account → verify the
    post and URN on LinkedIn.
11. Record the observed menu path, plan, and outcomes in
    `05_INTEGRATIONS/MCP_CLIENT_COMPATIBILITY.md`.
