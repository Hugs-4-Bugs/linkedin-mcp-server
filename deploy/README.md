# Deployment (M5 foundation)

This directory makes the server deployable as a remote MCP endpoint with
persistent storage, real authentication and TLS. **Nothing here has been
deployed to a live host yet** — these are verified configuration +
runbooks; the first real deployment is a manual owner action (§Manual steps).

## Topology

```
Internet ──443/TLS── Caddy (auto-HTTPS) ──> app (node, 0.0.0.0:3333) ──> Postgres 17
                                                 │
                                                 ├── /mcp       MCP (session or bearer auth)
                                                 ├── /admin     console UI
                                                 ├── /auth/*    login/logout/state
                                                 ├── /linkedin/* OAuth 3LO routes
                                                 └── /healthz   liveness (no auth)
```

- **App**: `dist/mcp/transport/http-entry.js` (staging config enforces
  0.0.0.0 + persistence + TOKEN_VAULT_KEY + real OAuth provider —
  see `src/config/config.ts` production/staging fail-fast rules).
- **DB**: Postgres 17 (migration `m1:core tables` runs automatically at
  startup, idempotently). SQLite is supported for local/dev
  (`DATABASE_URL=sqlite:file.db`) — same schema, same stores.
- **TLS**: terminated at Caddy; the app itself speaks plain HTTP on the
  compose network only, never published directly.

## First-run sequence (staging)

1. Create the LinkedIn app (owner manual action —
   `05_INTEGRATIONS/LINKEDIN_DEVELOPER_SETUP.md`) and get
   Client ID/Secret; set the redirect URI to
   `https://<hostname>/linkedin/callback`.
2. `cp deploy/env.staging.example deploy/.env` and fill:
   `PUBLIC_HOSTNAME`, `POSTGRES_PASSWORD`, LinkedIn credentials,
   `TOKEN_VAULT_KEY` (32-byte base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
3. `cd deploy && docker compose up -d`.
4. Create the first console user (keep the DB URL identical):
   `docker compose exec app node dist/scripts/bootstrapAdmin.js <username> '<password>'`
5. Open `https://<hostname>/admin`, sign in, Connect LinkedIn, publish.

## Operations

- **Preflight** (before first up and before every config change):
  `node dist/scripts/preflight.js` — validates env shape, secret strength,
  DB reachability and applies/verifies migrations. Compose deployments:
  set `PREFLIGHT_COMPOSE=1` to also check `POSTGRES_PASSWORD`.
- **Post-deploy smoke** (run against the live host URL):
  `./deploy/staging-smoke.sh https://<host> [user] [pass]` — 10 checks:
  TLS/health/security headers/401 enforcement/console/body cap/login/
  authenticated MCP initialize. All must pass before connector testing.
- **Health**: `GET /healthz` → `{ok, backend, env}` (also the container
  HEALTHCHECK).
- **Graceful shutdown**: SIGTERM/SIGINT → stop accepting → close DB pool →
  exit 0 (10 s hard cap).
- **Migrations**: automatic at startup; a new migration = new entry in
  `src/storage/migrations.ts` (both dialects) + deployment note.
- **Backups**: `pg_dump` nightly (see `07_OPERATIONS/BACKUP_AND_RECOVERY.md`);
  the vault key must be backed up SEPARATELY — tokens are unrecoverable
  without it.
- **Rollback**: redeploy the previous image; schema is additive-only per
  migration policy; never downgrade across destructive migrations.
- **Resource/cost estimate** (single small VM, 2 vCPU/2 GB): app ~150–250 MB
  RSS, Postgres ~100–200 MB for pilot scale; Caddy negligible. Ballpark
  $15–40/month on typical VPS providers at pilot scale. No commitment made
  here; the owner selects the host.

## Security posture (enforced in code, verified by
`tests/integration/remote-security-e2e.test.ts`)

- `/mcp` and OAuth routes require authentication whenever persistent
  storage is active (401 otherwise); local dev loopback without
  `DATABASE_URL` stays open for the M1–M4 workflow.
- Tenant identity derives ONLY from the session credential / API token
  (AsyncLocalStorage to the tool layer); caller-supplied tenant headers are
  never read.
- Session tokens + CSRF tokens stored as SHA-256 digests; passwords scrypt
  (N=16384); uniform 401 messages (no user enumeration).
- Security headers (CSP `default-src 'none'`, nosniff, DENY, no-referrer),
  per-IP rate limit, request body cap (413), bounded mock-consent redirects.
- LinkedIn tokens sealed AES-256-GCM before storage (DB never sees
  plaintext); disconnect deletes rows.
- Production config fail-fast: mock auth or mock OAuth provider or missing
  persistence/vault key → startup error, not a silent fallback.

## What is NOT yet done (honest)

- No live deployment, no real TLS certificate obtained, no real LinkedIn
  credentials — all require owner manual action.
- Live Claude/ChatGPT connector validation (post-deploy checklists in
  `05_INTEGRATIONS/CLAUDE_INTEGRATION.md` and `CHATGPT_INTEGRATION.md`).
- M6's PG integration tests run a real PostgreSQL 19 engine via the
  `embedded-postgres` devDependency; the compose stack pins postgres:17 —
  same dialect surface; re-run the suite + smoke against the live 17 host
  at first staging deploy.
- Multi-instance horizontal scale is untested (SQLite executor is
  single-process by design; Postgres executor pools per process).
- Migrations tooling is code-defined; no `migrate:rollback` command.
