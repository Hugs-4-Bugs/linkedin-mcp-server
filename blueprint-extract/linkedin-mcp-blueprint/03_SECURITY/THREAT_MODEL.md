# Threat Model (M7, issue #12 — verified against the codebase)

Scope: the LinkedIn MCP Server as deployed for staging (remote Streamable
HTTP, Postgres/SQLite persistence, Caddy TLS front). Local stdio mode is
covered where it shares the same code paths.

## 1. Assets

| Asset | Where it lives | Impact if compromised |
|---|---|---|
| LinkedIn OAuth access tokens (per tenant) | `linkedin_tokens` rows, AES-256-GCM ciphertext + key from `TOKEN_VAULT_KEY` env | Account takeover of the member's LinkedIn identity within granted scopes (`w_member_social` posting) |
| MCP-auth sessions + API tokens (digests) | `sessions` / `api_tokens` rows (SHA-256 digests), cookie `lkm_session` in the browser | Tenant impersonation on the remote surface |
| User password hashes | `users` rows (scrypt, per-user salt) | Credential-stuffing target if DB leaks |
| OAuth CSRF `state` | `oauth_states` rows (ephemeral) | OAuth replay/false-tenant binding |
| Publish safety ledger + budgets | `publish_operations` / `publish_budgets` rows | Safety-limit bypass (duplicate spam, over-quota posting) |
| Audit trail | `audit_log` rows (identifiers only, never payloads) | Forensics loss if tampered |
| LinkedIn-derived profile data | Vault-sealed token payload + tool responses in transit | Privacy exposure (ADR-010 24h-class data) |

## 2. Trust boundaries

```
[Claude/ChatGPT connector]      --TLS(443, Caddy)-->  [Node server /mcp]
                                                    (auth: session cookie | bearer)
[Browser /admin]                 --TLS-------------->  same server
[Node server]                    --TLS-------------->  [LinkedIn OAuth + API] (3LO)
[Node server]                    ----------------->   [SQL store: PG | SQLite]
[deploy host]                    ----------------->   [Caddy ingress, secrets in .env]
```

Boundaries and the one-way rules that hold at each:

- **B1 client→server**: connector/admin traffic is untrusted; every request
  is authenticated before protocol handling (401 otherwise); no
  caller-supplied identity is trusted (tenant derives from the credential
  only, via AsyncLocalStorage — ADR-019).
- **B2 server→LinkedIn**: outbound only to fixed hosts
  (`api.linkedin.com`, `www.linkedin.com` OAuth); tokens travel only on
  that leg; responses pass strict allowlist validation (ADR-014).
- **B3 server→SQL**: the DB is a trust boundary for confidentiality, not
  integrity: tokens are ciphertext, session/API tokens are digests, so a
  read-only DB leak yields no usable credentials.
- **B4 process↔env**: `TOKEN_VAULT_KEY`, client secret and DB password live
  in env/.env (0600, compose env_file) — never in source/logs (secret scan
  enforces in CI; logger redacts on write).

## 3. STRIDE analysis (each row: threat → mitigation in THIS repo → test evidence)

| # | Threat (STRIDE) | Mitigation implemented | Evidence |
|---|---|---|---|
| 1 | **S**poof: stolen session cookie | HttpOnly+SameSite=Lax(+Secure off-local) cookie; digest-at-rest; expiry at read; revocation on logout; redacted logs | remote-security-e2e (logout→401; M6 chatgpt suite lifecycle) |
| 2 | **S**poof: caller forges tenant via header/argument | Tenant ONLY from authenticated credential (ALS); identity-dependent tools take `{}` strict schemas | profile-security (member-substitution impossible by construction, ADR-014) |
| 3 | **T**amper: OAuth state replay / CSRF on OAuth callback | Random 32B state bound to tenant, single-use, TTL'd, tenant-checked on consume | oauth-hygiene + M6 pg-integration (replay/tenant-mismatch/expired) |
| 4 | **T**amper: prompt injection via LinkedIn content fields | LinkedIn-derived text is data only: it never feeds tool logic; no content-as-instructions; responses allowlist-validated | PROMPT_INJECTION_DEFENSE + profile fixtures |
| 5 | **R**epudiation: tool calls / disconnects unattributed | Audit rows: login/logout (M5), tool name+outcome and disconnect (M7) — actor=tenant identifiers, no payloads | retention.test.ts (audit written; log hygiene asserted) |
| 6 | **I**nformation disclosure: token/secret in logs | Logger redacts banned keys/patterns incl. `Bearer …`; error bodies sanitized; provider bodies never surfaced | logger.test.ts + compat suites' no-leak assertions |
| 7 | **I**nformation disclosure: DB leak yields usable creds | AES-256-GCM ciphertext-only vault (key not in DB); scrypt hashes; SHA-256 session digests | pg-integration (ciphertext-only assert), db-persistence |
| 8 | **D**enial of service: body flooding | 1 MiB body cap → 413; per-IP rate limit; per-tenant connect-rate (6/10min) | gate-regressions + M6 smoke check 7 |
| 9 | **E**levation: unconfirmed publish / duplicate spam / quota bypass | `confirm: z.literal(true)` schema gate; duplicate window; in-flight lock; daily budget; no auto-retry ambiguous | publish-security (whole suite) |
| 10 | **E**levation: cross-tenant reads | Every vault/state/ledger/budget row is tenant-keyed; queries bind tenant from credential | M6 pg-integration isolation tests; db-persistence |
| 11 | SSRF via redirect/callback URLs | Redirect URI fixed by config; state binds the tenant that created it; outbound hosts are constants | oauth-flow-e2e |
| 12 | Dependency compromise | Pinned versions, `npm audit` gate (0 vulns, dev+prod), no runtime dep added in M7 | CI pipeline + DEPENDENCY_POLICY |
| 13 | Token theft → persistent access | Token expiry enforced at read (expired→disconnected); disconnect deletes ciphertext; revocation of sessions/API tokens immediate | connectionService tests + M7 retention tests |
| 14 | Retention violation (stale data classes) | PeriodicSweeper per-class TTL deletion (sessions/states/ledger/audit/budgets/revoked tokens) — ADR-010/D-006 now enforced | retention.test.ts + pg-integration sweep test |

## 4. Residual risks (accepted, documented)

- MCP-side OAuth for connectors is future work; bearer-token connector
  mode is the documented interim (CLAUDE/CHATGPT_INTEGRATION).
- The vault key is process-env held; a host compromise reads plaintext of
  active tenants (mitigated by disconnect + deletion paths, this milestone).
- embedded-postgres (dev-only) downloads platform binaries at install
  time — dev machines only, never runtime.
- Rate limiting is in-process fixed-window (single-instance scale);
  multi-instance deployments need an external limiter (future).
- No 2FA on console login (single-admin posture, owner decision).
