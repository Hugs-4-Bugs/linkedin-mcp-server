# Scope

## MVP candidate
- Health/status tool.
- OAuth connection flow and status (only supported scopes).
- Permission-aware tool discovery.
- Small set of verified read operations.
- Only verified write operations, with confirmation and idempotency safeguards where appropriate.
- Local stdio mode for development and remote Streamable HTTP mode if host support/authorization is verified.
- Structured diagnostics that redact secrets.

## Later
- SaaS dashboard, subscriptions, payment integration, plan/usage management, team features, admin console, analytics, additional supported APIs.

## Exclusions
- Scraping, private endpoints, cookie-based auth, browser automation of LinkedIn, bypasses, spam automation, mass invitations/messages, or feature claims unsupported by LinkedIn.
