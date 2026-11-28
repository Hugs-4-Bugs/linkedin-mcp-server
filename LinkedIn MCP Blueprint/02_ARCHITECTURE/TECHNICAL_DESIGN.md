# Technical Design

Stack: supported Node.js LTS, TypeScript strict mode, official MCP TypeScript SDK (verify current version and package/API before use), schema validation library compatible with SDK, HTTP framework chosen after benchmark/compatibility review, PostgreSQL for SaaS persistence, migrations, structured logger, OpenTelemetry, test framework, CI.

Suggested modules: `mcp/`, `auth/`, `identity/`, `linkedin/`, `tools/`, `policy/`, `entitlements/`, `usage/`, `storage/`, `jobs/`, `observability/`, `config/`. Keep imports directional and enforce with lint/graph checks.

Avoid adding cache/queue unless use case justifies it. Candidate later: Redis for rate-limiting/distributed cache and job coordination; durable queue for async tasks.
