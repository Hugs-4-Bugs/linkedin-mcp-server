# Security Checklist

- [ ] OAuth state/PKCE protections validated
- [ ] Redirect URI allowlist
- [ ] Tokens encrypted and redacted
- [ ] Tenant isolation tests
- [ ] Tool schemas and size limits
- [ ] Authorization and scopes per tool
- [ ] Side-effect confirmation and idempotency review
- [x] Rate limits and timeout controls — M2 connect rate limit + M4 publish budget/duplicate window (app-level; LinkedIn publishes no numeric quota — ADR-015); userinfo 10 s + publish 30 s AbortController timeouts
- [ ] SSRF controls for any URL handling
- [ ] Prompt injection test fixtures
- [ ] Dependency and secret scans
- [ ] Audit events without sensitive payloads
- [ ] Deletion/disconnect tests
- [ ] Incident and recovery procedures
- [ ] Production environment review

## M5 additions (2026-11-27) — implemented & verified

- [x] Remote authentication independent of caller-supplied tenant IDs — credentials only (session cookie / bearer), AsyncLocalStorage to tools; forged tenant headers never read (E2E-verified inert)
- [x] Tokens encrypted at rest in the DB (AES-256-GCM envelope; ciphertext-only canary test)
- [x] Session + CSRF tokens stored as SHA-256 digests; scrypt passwords (N=16384, per-user salt, constant-time)
- [x] Uniform auth failures (no user enumeration); no sensitive data in auth errors
- [x] Logout/revocation; expired sessions rejected; API tokens revocable
- [x] Security headers on every response (CSP default-src 'none', nosniff, DENY, no-referrer, no-store)
- [x] Request-size cap (413) + per-IP rate limit (429) at the HTTP bridge
- [x] OAuth state replay protection in persistence (atomic single-use, E2E: consume-once)
- [x] No open redirect (mock-consent redirect_uri bounded to the configured host)
- [x] Production/staging fail-fast: mock auth or mock OAuth provider, missing persistence or vault key → startup error
- [x] Graceful shutdown (SIGTERM → drain → DB close); /healthz liveness without auth or data
- [x] stdio + local loopback dev workflow unchanged (166 regression tests)
