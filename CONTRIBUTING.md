# Contributing to linkedin-mcp-server

Thank you for your interest. This project accepts contributions via
GitHub pull requests. Everything below is required before review.

## Development environment

- Node.js >= 24 (see `package.json` `engines`); npm >= 10.
- `npm install` — installs runtime and dev dependencies.
- Local, dependency-free workflow: `npm run dev` (stdio, in-memory
  storage, mock OAuth provider). No LinkedIn credentials needed.

## Gates — all must pass before a PR is reviewable

```
npm run typecheck     # strict tsc, 0 errors
npm run lint          # eslint, 0 errors 0 warnings
npm run build         # clean dist
npx vitest run        # full suite (unit + security + SQLite + real-PG*)
bash scripts/secret-scan.sh   # must print "clean"
```

`*` Real-PostgreSQL tests (`tests/integration/pg-integration.test.ts`)
auto-provision an ephemeral embedded-postgres on first run (dev machine).
If they are skipped locally, say so in the PR and CI will cover them.

## Ground rules

1. **Scope**: PRs should map to a GitHub issue; reference it with
   `Refs #N` (never `Fixes`/`Closes` — the owner closes issues).
2. **Secrets**: never commit credentials, tokens, or real LinkedIn data.
   The secret scan is a hard gate. Tests use fixtures only.
3. **Tests**: security-relevant changes need regression tests (both the
   allowed and the rejected path). Don't weaken or skip existing tests.
4. **License**: by contributing you agree your contribution is licensed
   under AGPL-3.0-or-later (see LICENSE and NOTICE). Keep the header
   comments in any file you touch.
5. **Sign-off**: commits carry `Signed-off-by: Name <email>`
   (`git commit -s`), certifying the DCO statement: "I certify that I
   have the right to submit this work under the project's license."
6. **Data**: never attach real member data; mock-provider fixtures only
   (see `src/auth/linkedin/mockProvider.ts`).
7. **Docs**: user-visible behavior changes update `README.md` and the
   relevant `03_SECURITY/` or `07_OPERATIONS/` doc in the same PR.

## Review

The repository owner reviews and merges manually. Security-sensitive PRs
(gets auth, vault, persistence, transport) get extra scrutiny: describe
the threat you're defending against and point at the test that proves it
(see `03_SECURITY/THREAT_MODEL.md` numbering).
