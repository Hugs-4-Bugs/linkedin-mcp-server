# LinkedIn API Integration

Phase 0 must create a capability matrix with: capability, API product, endpoint documentation, scope, access status, approval requirements, rate limits, restrictions, testability, and decision.

All LinkedIn calls go through adapter interfaces. No undocumented endpoints. Use official documentation and approved APIs only. Handle rate limits and errors respectfully. Do not retry non-idempotent actions automatically unless safe and supported.

## M4 capability matrix entries (2026-11-27, verified against official documentation)

| Capability | API product | Endpoint (documented) | Scope | Access status | Rate limits | Restrictions | Verified |
|---|---|---|---|---|---|---|---|
| Publish text post (member) | Posts API | `POST https://api.linkedin.com/rest/posts` (Microsoft Learn "Posts API", li-lms-2026-11) | `w_member_social` | Self-serve OK (per docs table) | Not published numerically (per-app in Developer Portal; 429 on throttle) | Text-only ≤3000 chars; no media/targeting/reshare in M4; `Linkedin-Version` + `X-Restli-Protocol-Version: 2.0.0` headers required; 201 + `x-restli-id` URN | Request/response shapes verified via injected fetch; LIVE publishing NOT verified (no credentials) |
| Draft/preview post | — (local) | none | none | n/a | n/a | Local validation only; no persistence | Behavioral tests |
| Duplicate protection | — (local ledger) | none | none | n/a | n/a | In-flight lock + content-hash window + ambiguous-suspect; NOT exactly-once (ADR-016) | Behavioral tests |

**Corrections recorded this milestone:** the earlier "150 req/member/day" note had no official source and is retracted (ADR-015); application-level `PUBLISH_DAILY_LIMIT` (default 12) is the enforced safety limit. Author URN mapping `urn:li:person:{sub}` is community-verified (flagged in ADR-017 for live confirmation).
