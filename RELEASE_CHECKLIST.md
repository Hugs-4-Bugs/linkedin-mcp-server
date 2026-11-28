# Release Checklist (M8, issue #15)

Run for every tagged release. Owner executes; nothing here is automated
by agents (governance decisions stay with the owner).

## 1. Source & license

- [ ] `LICENSE` present, byte-identical to canonical AGPL-3.0 (checked
      automatically: tests/security/release-checklist.test.ts).
- [ ] `NOTICE` current (copyright year, contact, third-party census).
- [ ] `package.json` `license` = `AGPL-3.0-or-later`; `private` removed
      only at publish time by the owner.
- [ ] Dependency license census green (automated test; no GPL/AGPL
      additions that would change the distribution terms).
- [ ] `git fsck --no-dangling` clean; no force-pushes in history.

## 2. Quality gates (all must be green)

- [ ] `npm run typecheck` 0 errors.
- [ ] `npm run lint` 0 errors 0 warnings.
- [ ] `npm run build` succeeds.
- [ ] `npx vitest run` full suite green (baseline count recorded in
      the milestone handoff; never below the previous release).
- [ ] Real-PostgreSQL suite green (CI or local embedded-postgres).
- [ ] `npm audit` + `npm audit --omit=dev`: 0 vulnerabilities.
- [ ] `bash scripts/secret-scan.sh`: clean.

## 3. Documentation

- [ ] README accurate for the release (install, config, run modes).
- [ ] CHANGELOG.md entry added with date and milestone scope.
- [ ] SECURITY.md / 03_SECURITY/ policy docs current.
- [ ] Privacy/data documentation (DATA_PRIVACY.md) reviewed for the
      release horizon values (retention knobs).

## 4. Tagging & provenance

- [ ] Version bumped in package.json (semver; 0.x until v1).
- [ ] Signed tag: `git tag -s vX.Y.Z -m "X.Y.Z: <one-line>"`.
- [ ] Tag SHA recorded in the release notes; tarball checksums
      published with the release (`sha256sum` of the tarball).
- [ ] Release artifacts attached by the owner from CI build or clean
      local build — never from a dirty tree.

## 5. Hosted-service obligations (AGPL §13, when a hosted instance runs)

- [ ] Corresponding-source offer present for network users (repo URL +
      exact running version/tag) — see DEPLOYMENT.md.
- [ ] NOTICE contact reachable; source offer must point at the exact
      tag, not a moving branch.

## 6. Post-release

- [ ] Announcement (owner channels) with SHA + checksums.
- [ ] Branch protection / tag protection confirmed untouched.
- [ ] Rollback path reviewed (07_OPERATIONS/ROLLBACK.md).
