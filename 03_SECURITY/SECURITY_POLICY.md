# Security Policy

## Reporting Security Vulnerabilities

Do not open a public issue for an undisclosed security vulnerability.

Report vulnerabilities privately through GitHub's repository Security Advisories:
https://github.com/Hugs-4-Bugs/linkedin-mcp-server/security/advisories

If private vulnerability reporting is unavailable, contact the repository maintainer through an independently verified private contact channel.

## Response Commitment

The maintainer aims to acknowledge security reports within 72 hours. This is a response target, not a guarantee of remediation time. Reporter updates, severity assessment, mitigation and disclosure timing depend on the vulnerability and available resources.

## Scope

Security reports relevant to this project include, but are not limited to:

- OAuth state, redirect validation and authentication bypass.
- Token leakage, insecure storage or cryptographic failures.
- Cross-tenant access or data exposure.
- MCP tool authorization, validation or unintended side effects.
- Prompt injection, SSRF, abuse and denial-of-service weaknesses.
- Sensitive data exposure through logs, metrics or administrative interfaces.
- Deployment, dependency or configuration vulnerabilities.

## Safe Reporting

Include a concise description, affected component, impact, reproducible steps and supporting evidence where possible. Avoid accessing, modifying, deleting or disclosing another person's data. Do not perform destructive testing against production systems.

## Handling

Reports should be reviewed, assessed, reproduced safely, triaged, mitigated and tracked through remediation and disclosure. Do not publish vulnerability details before coordinated disclosure.

## Security Boundaries

This policy does not grant authorization to access systems, accounts, data or services outside the reporter's lawful authorization.
