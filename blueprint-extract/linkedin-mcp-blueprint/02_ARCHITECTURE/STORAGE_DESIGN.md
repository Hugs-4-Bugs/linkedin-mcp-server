# Storage Design

Use PostgreSQL if hosted multi-user persistence is required. Tables/entities initially: users, tenants (or workspace), tenant memberships if multi-user, linked accounts, OAuth credential references/encrypted token material, scopes/permissions, usage records, subscription/entitlement records (future), audit events, consent records and operational metadata.

Minimize stored LinkedIn content; prefer transient processing. Define retention and deletion. Token material must be encrypted with managed key strategy, not plain database text. Use migrations, constraints, tenant-scoped queries and backup/restore tests.
