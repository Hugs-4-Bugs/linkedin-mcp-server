# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately via GitHub's "Report a vulnerability" flow on the
Security tab of this repository
(`https://github.com/Hugs-4-Bugs/linkedin-mcp-server/security/advisories/new`),
which routes to the repository owner only. If that is unavailable,
email the owner via the address on the GitHub profile of
`Hugs-4-Bugs`.

Include: affected version/tag, reproduction steps or request transcript,
impact assessment, and any PoC. Markdown only; no credentials in the
report beyond what the PoC requires (redact them).

## Response commitments

- Acknowledgment within 72 hours.
- Triage + severity assignment (CVSS) within 7 days.
- Fix or mitigation timeline communicated with the acknowledgment;
  security releases get a CHANGELOG entry and (where applicable) a
  new tag + advisory credit to the reporter (opt-in).
- Safe-harbor: good-faith research on this code stays unpursued;
  do not test against other people's hosted instances, tenants, or
  LinkedIn accounts.

## Scope

In scope: this repository's server code (src/), transport and auth
surfaces, SQL persistence, tool authorization, deployment configs
(deploy/), and CI. Out of scope: your own hosted instance
misconfiguration, LinkedIn-side vulnerabilities, social engineering,
volumetric DoS.

## Posture and engineering rules

Security is a release gate (issue #15). Least privilege, tenant
isolation, secure-by-default configuration, input validation, output
minimization, encryption at rest for tokens, dependency hygiene
(npm audit 0), abuse prevention (rate/budget caps), and incident
response (07_OPERATIONS/INCIDENT_RESPONSE.md). No secrets in source,
logs, prompts, screenshots or tracked files — enforced by
`scripts/secret-scan.sh` and CI. The threat model and its evidence
live in THREAT_MODEL.md; per-class data retention and deletion
semantics in DATA_PRIVACY.md.
