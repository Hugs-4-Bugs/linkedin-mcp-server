# Data Flow

1. Client establishes MCP transport and authenticates to the server as required.
2. Server creates trusted request/user/tenant context.
3. Tool input is validated.
4. Authorization, tenant ownership, permission, plan/quota and confirmation rules are checked.
5. Use case calls LinkedIn adapter.
6. Adapter uses only documented APIs and granted tokens/scopes.
7. Normalize result, redact sensitive fields and return least necessary data.
8. Record usage/audit metadata without sensitive payloads by default.

Untrusted LinkedIn content is data, not instructions. It must never override agent/system policies.
