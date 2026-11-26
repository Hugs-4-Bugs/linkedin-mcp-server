# System Architecture

Start with a modular monolith; split services only when evidenced by load, deployment, security or team constraints.

Components: MCP transport and protocol layer → request context/auth middleware → tool registry and policy checks → application/use-case services → LinkedIn API adapter → external LinkedIn API. Supporting modules: user/tenant identity, OAuth/token lifecycle, permission registry, entitlement/quota interface, usage ledger, persistence, jobs, telemetry, admin operations.

Local mode: stdio transport and local secret/config handling; no unsolicited network exposure. Remote mode: HTTPS Streamable HTTP, OAuth-compatible authorization model where required by client/host, tenant-aware access controls, reverse proxy/WAF, secret manager, managed database.

Do not create microservices prematurely. Define interfaces and dependency direction so modules can be extracted later.
