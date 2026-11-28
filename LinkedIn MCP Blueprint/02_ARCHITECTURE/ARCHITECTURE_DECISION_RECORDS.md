# Architecture Decision Records

## ADR-001: TypeScript MCP core
Status: proposed/approved by blueprint owner. Reason: first-party MCP SDK maturity and integration velocity. Java remains viable but not selected.

## ADR-002: Modular monolith
Start with clear module boundaries; avoid premature microservices.

## ADR-003: Official LinkedIn API only
Do not use scraping, cookie auth, private endpoints, or bypasses.

## ADR-004: Monetization-ready interfaces, not monetization MVP
Build identity, tenant, quota and entitlement seams. Implement payments only after validation and owner approval.
