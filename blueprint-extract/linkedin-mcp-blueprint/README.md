# LinkedIn MCP — Engineering Blueprint

This repository is a planning, specification, and agent-operating package for building a LinkedIn MCP server for Claude and ChatGPT. It is not an implementation and does not promise LinkedIn API permissions.

## Decisions
- Stack: Node.js + TypeScript, modular monolith initially.
- MCP: official TypeScript SDK, selected stable release verified at implementation time.
- Integrations: official LinkedIn APIs and approved products/permissions only.
- Accounts: support personal-member and organization/page account contexts only where API access permits.
- Deployment: local development plus remote hosted deployment.
- SaaS-ready design: multi-tenant identity, entitlement/quota interfaces, usage records, billing-ready abstraction; monetization is not part of MVP unless separately approved.
- Clients: Claude and ChatGPT, independently verified against their current MCP connection requirements.

## Start
1. Read `START_HERE.md`.
2. Read `04_AI_AGENT/AGENT_RULES.md` and `AGENT_SYSTEM_INSTRUCTIONS.md`.
3. Read product requirements and architecture documents.
4. Agent must audit API access and client compatibility before implementation.
5. Start only with Phase 0 in `09_PROMPTS/MASTER_PROMPT.md`.

## Important limitation
LinkedIn API availability, permissions, partner program approval, and allowed use are controlled by LinkedIn. The product must not simulate access to unavailable endpoints or use scraping/session-cookie/bypass techniques.

## License and contribution (M8)

This project is licensed under **AGPL-3.0-or-later** — see
[LICENSE](LICENSE) and [NOTICE](NOTICE). A hosted instance of a modified
version must offer Corresponding Source to its network users (AGPL §13);
the release checklist tracks that obligation.

- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md) (gates, DCO sign-off).
- Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Security reporting: [03_SECURITY/SECURITY_POLICY.md](03_SECURITY/SECURITY_POLICY.md).
- Data handling: [03_SECURITY/DATA_PRIVACY.md](03_SECURITY/DATA_PRIVACY.md).
- Releases: [CHANGELOG.md](CHANGELOG.md) and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
