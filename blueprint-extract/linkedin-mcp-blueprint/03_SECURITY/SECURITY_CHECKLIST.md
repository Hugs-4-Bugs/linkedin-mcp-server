# Security Checklist

- [ ] OAuth state/PKCE protections validated
- [ ] Redirect URI allowlist
- [ ] Tokens encrypted and redacted
- [ ] Tenant isolation tests
- [ ] Tool schemas and size limits
- [ ] Authorization and scopes per tool
- [ ] Side-effect confirmation and idempotency review
- [ ] Rate limits and timeout controls
- [ ] SSRF controls for any URL handling
- [ ] Prompt injection test fixtures
- [ ] Dependency and secret scans
- [ ] Audit events without sensitive payloads
- [ ] Deletion/disconnect tests
- [ ] Incident and recovery procedures
- [ ] Production environment review
