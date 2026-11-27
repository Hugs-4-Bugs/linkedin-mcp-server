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
