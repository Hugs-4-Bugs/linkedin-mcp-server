# MCP Protocol Design

Expose tools/resources/prompts only where useful and supported. Each tool must have: stable identifier, precise description, typed schema, authorization/scopes, input limits, side-effect classification, confirmation strategy, timeout, retry policy, error mapping, test fixtures, audit strategy.

Use stdio for local development and remote Streamable HTTP where clients support it. Verify current protocol version and SDK compatibility before locking. Avoid relying on transport-specific behavior without testing both client integrations. Never write diagnostic logs to stdout in stdio mode; use stderr.
