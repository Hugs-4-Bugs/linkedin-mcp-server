# Data Privacy

## Purpose and Data Minimization

This service provides LinkedIn-related MCP functionality. It should process only information necessary for authentication, requested tool operations, application security, persistence and service operation.

Do not intentionally collect unrelated personal information. LinkedIn-derived content must not be sent to billing or analytics systems.

## Data classes and retention

| Data class | Storage and retention behavior |
|---|---|
| OAuth states | Expired states are deleted; configured default lifetime is 10 minutes. |
| Sessions | Deleted after their stored expiration timestamp; default session lifetime is 8 hours. |
| API tokens | Revoked tokens are eligible for deletion after the default 24-hour grace period. |
| LinkedIn credentials | Stored in the token vault; disconnect deletes the tenant's stored token row. |
| Publish operation records | Ended records are deleted after the default 10-minute duplicate-operation window. |
| Audit records | Default retention is 90 days. Audit records are intended to contain actor/action identifiers rather than LinkedIn content. |
| Publish budget records | Orphaned budget records are deleted after the default 24-hour window. |
| Billing records | Billing lifecycle and webhook replay-protection records are excluded from the RetentionSweeper deletion classes. |

These defaults are based on the application's RetentionPolicy and configuration. Environment overrides may change applicable retention settings.

## RetentionSweeper

The RetentionSweeper periodically removes expired or obsolete records from supported storage classes. A boot sweep is performed when the periodic sweeper is wired into runtime. Periodic sweeping can be disabled through configuration, although the boot sweep remains enabled in that configuration path.

Sweep logs report deletion counts and data-class names rather than deleted row contents.

## Deletion semantics

- LinkedIn disconnect deletes the tenant's stored LinkedIn token row.
- User account removal deletes the user's associated records covered by the account-removal transaction, including sessions, API tokens, vault data and relevant application records.
- Deletion is tenant-scoped; tests verify that another tenant's data remains intact.
- Expired records are deleted according to the retention sweep rules.
- Billing records such as webhook replay-protection records are not automatically deleted by the RetentionSweeper.

Deletion from application storage does not necessarily remove copies retained by external providers, backups, infrastructure logs or other systems outside this application's control.

## Data Security

Credentials are stored through the token-vault implementation. Secrets must not be placed in source code, committed environment files, logs or public issue reports. Access must follow least-privilege principles.

## Disconnect and Account Removal

Disconnect removes stored LinkedIn tokens for the relevant tenant. Account-removal behavior is covered by storage-layer tests. Users should not assume that disconnect is equivalent to deleting every account, billing or external-provider record.

## Privacy Limitations and Legal Review

This document describes the application's implemented storage and retention behavior and its intended handling practices. It is not a legal privacy notice or a guarantee of regulatory compliance.

Before public launch, review applicable privacy laws, LinkedIn contractual requirements, external-provider retention, backups, operational logs and user-facing disclosures with qualified counsel.
