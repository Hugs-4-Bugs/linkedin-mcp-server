# Threat Model

Threats: token theft, OAuth CSRF, redirect manipulation, malicious MCP client, cross-tenant data leakage, tool abuse, prompt injection through LinkedIn content, SSRF, denial-of-service, dependency compromise, log leakage, accidental side effects, insecure deployment, billing/usage abuse.

Mitigations: OAuth state/PKCE where applicable, redirect allowlist, secure token storage, scoped access, strict schemas, output sanitization, no content-as-instructions, confirmation gates, bounded requests, rate limits, SSRF defenses, dependency scanning, security tests, tenant-bound queries, redacted logs and deployment review.
