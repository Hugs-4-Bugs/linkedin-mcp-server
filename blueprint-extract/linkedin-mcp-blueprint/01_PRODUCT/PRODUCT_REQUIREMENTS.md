# Product Requirements

## Requirements
- MCP server with local and remote modes, subject to client compatibility.
- Support Claude and ChatGPT connection paths, documented separately and validated at release time.
- OAuth-based LinkedIn connection where the relevant API product permits it; secure token storage and refresh handling as supported.
- Personal and organization account context, only for granted scopes and API-supported resources.
- Tool catalog must reflect actual permissions and feature availability.
- Clear tool descriptions, input validation, structured errors and consent/confirmation for consequential operations.
- SaaS-ready identity, tenant isolation, entitlement checks and usage metering interfaces.
- User disconnect, data deletion and token revocation workflows where applicable.
- Audit records for sensitive actions; avoid logging secrets or unnecessary personal data.
- Documentation, tests, deployability and observability.

## Non-functional targets (initial hypotheses; revise after baseline)
- Availability target: 99.5% monthly for hosted MVP, subject to external dependencies.
- API/tool latency: establish baseline; do not promise latency for LinkedIn-dependent calls.
- Scale horizontally for stateless application replicas; session/token storage externalized.
- Security: least privilege, secure OAuth, encryption in transit and at rest, rate limiting, tenant isolation.
- Accessibility and UX: errors and consent states understandable without technical knowledge.

## Acceptance
Every tool is mapped to a verified API capability, permission, official documentation reference, tests, and documented limitations.
