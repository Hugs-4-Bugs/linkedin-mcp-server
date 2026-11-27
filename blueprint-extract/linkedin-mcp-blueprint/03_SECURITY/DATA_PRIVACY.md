# Data Privacy & Retention (M7, issues #12/#16)

Purposes, retention classes, deletion semantics and log hygiene for every
persisted data class in this server (schemas: `src/storage/migrations.ts`).

## 1. Data classes and retention

| Class | Table | Content | Retention | Enforcement |
|---|---|---|---|---|
| OAuth CSRF state | `oauth_states` | random state bound to tenant, redirect URI | TTL seconds (default 10m) | single-use consume + TTL sweep |
| Session artifacts | `sessions` | token digests, CSRF digests, expiry | TTL = SESSION_TTL_SECONDS (8h default) | expiry-at-read + sweep |
| API tokens | `api_tokens` | digests + label | revoked → 24h grace, then sweep | revocation + sweep |
| LinkedIn token set | `linkedin_tokens` | AES-GCM ciphertext, scopes, memberSub | while connected; DELETED on disconnect | disconnect + account removal |
| Publish ledger | `publish_operations` | content HASH (not text), state, URN | duplicate window (10m default) after ended | sweep |
| Publish budgets | `publish_budgets` | hit timestamps | one window (24h) | sweep |
| Audit trail | `audit_log` | tenant/actor/action identifiers only | AUDIT_RETENTION_DAYS (90 default) | sweep |
| User identity | `users` | username, scrypt hash, tenant id | account lifetime | account removal cascades |

Enforcement point: `RetentionSweeper` (`src/storage/retention.ts`) —
periodic (RETENTION_SWEEP_INTERVAL_SECONDS, 1h default, 0 = boot-only)
per-class TTL deletion; wired at server startup and stopped at graceful
shutdown (M7, ADR-010/D-006).

## 2. Deletion semantics

- **Disconnect** (`linkedin_disconnect`, confirm-gated): deletes the
  tenant's sealed token row immediately — verified by SQL-level tests
  (retention.test.ts: ciphertext row count goes to zero).
- **Account removal** (`UserAuthStore.deleteUser`, M7): one transaction
  deletes the user + sessions + API tokens + LinkedIn ciphertext + ledger
  + budgets + audit rows for that tenant. Not exposed as an HTTP route
  (owner-operated via script/console for now — documented owner action).
- **Log hygiene**: logs and audit rows carry identifiers, shapes and
  counts only — never token values, never LinkedIn content, never tool
  payloads. The redaction layer (`observability/logger.ts`) drops banned
  keys and `Bearer …` values at write time; tests assert no
  `lkm_session`/password/vault-key strings appear in any output.
- **Minimization**: draft/preview never store post text; the ledger keeps
  only the content hash; profile data is never persisted server-side
  (streamed tool responses only, ADR-014 allowlist applied first).

## 3. Owner actions before launch

- Review retention horizons against the LinkedIn API terms your app is
  approved under (Marketing API storage rules cited in ADR-010) and adjust
  the config knobs.
- Decide the audit retention horizon (90d default) against compliance
  needs; document the chosen value.
- Provide the account-removal surface you prefer (admin route or CLI)
  before any multi-user rollout.
