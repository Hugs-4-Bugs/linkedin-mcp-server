# Scalability

Phase 1: modular monolith, stateless app replicas, externalized PostgreSQL and secrets, HTTP transport, bounded timeouts, concurrency controls, tenant-aware rate limits, health probes, telemetry. Scale horizontally when metrics justify it.

Phase 2: optional distributed cache, durable queue/background worker, billing integration, admin web app, stronger tenancy controls.

Phase 3: extract services only when measured needs justify cost/complexity. Keep API adapter, OAuth, MCP protocol, billing and policy boundaries explicit. Avoid microservices, Kubernetes, and event-driven complexity for a low-traffic MVP unless justified.
