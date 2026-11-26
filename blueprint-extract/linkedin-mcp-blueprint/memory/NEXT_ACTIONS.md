# Next Actions

1. **OWNER: Review + approve the Phase 0 report** (`/home/z/my-project/download/PHASE_0_REPORT.md`) — answers to Q1–Q5 (SDK line, hosting/domain, Community Management API pursuit, launch posture, LinkedIn app ownership).
2. **OWNER: Create the LinkedIn developer app** — enable *Sign In with LinkedIn using OpenID Connect* + *Share on LinkedIn* (both self-serve), configure HTTPS redirect URIs (needs hosting decision), transfer Client ID/Secret via secret manager.
3. Agent (after approval): Milestone 1 — repo foundation (strict TS, pinned deps, CI, config validation, redacting logger, stdio + streamable-http transport skeleton, test scaffolding). No LinkedIn features until the app exists.
4. Agent: Milestone 2 — LinkedIn 3LO for `openid profile email w_member_social`, encrypted token vault, expiry/reconnect status, mocked-integration tests.
5. Agent: install Graphify (code-only local mode, ADR-011) once there is a codebase to graph; regenerate at milestones.
6. Defer: Community Management API application (if owner elects Q3), remote staging deploy, live Claude/ChatGPT validation, security review, monetization/legal review.