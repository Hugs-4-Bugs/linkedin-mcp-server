# Start Here

You do not need to understand MCP, OAuth, cloud deployment, or SaaS architecture to use this package. Use this folder as the source of truth with your coding agent.

## Before coding
- Create or select a Git repository.
- Give the coding agent the entire blueprint folder, not just the master prompt.
- Ask it to read all mandatory agent rules and project files.
- Ask it to perform Phase 0 audit only; do not allow implementation in the audit task.
- Verify LinkedIn Developer application ownership and the actual permissions/products available in the portal.
- Do not paste secrets into chats, issues, logs, or tracked files.

## Development sequence
Phase 0 audit and feasibility → architecture lock → foundation → OAuth/account connection → permission-backed API adapters → MCP tool catalog → client compatibility → tests → deployment → security review.

## Agent session discipline
At session start: read CURRENT_STATE, PROJECT_MEMORY, DECISIONS, TASKS, blockers, rules, and relevant architecture. At session end: update task status, progress, decisions, blockers, verification evidence, and next actions.

## Owner actions
The owner must create/verify LinkedIn developer app, accept relevant terms, apply for access where needed, configure callback URLs, supply secrets via secure environment/secret manager, and approve deployment/billing/security-sensitive actions.
