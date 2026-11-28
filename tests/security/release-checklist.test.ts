/**
 * M8 issue #15 — AGPL release checklist regression test.
 *
 * Makes the release checklist ENFORCED, not just documented: every item
 * the issue names (license, notices, contributor guide, code of conduct,
 * security policy, privacy documentation, release checklist) must exist,
 * be non-stub, and be internally consistent:
 *  - LICENSE is the canonical, complete AGPL-3.0 text (§13 present,
    verbatim structure markers, exact known length class — no truncation).
 *  - package.json license field matches; version == server version.
 *  - NOTICE names the license and third-party components.
 *  - Dependency license census: every locked package carries an
 *    AGPL-compatible license; unknowns FAIL (release gate).
 *  - CONTRIBUTING names the quality gates incl. secret scan + DCO.
 *  - SECURITY policy has a private reporting channel (never "open an
 *    issue"), response SLA and scope.
 *  - CI workflow runs the same gates a human runs.
 * Paths are repo-relative from package.json (works in CI checkout too).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string): string => readFileSync(join(repoRoot, p), 'utf8');

describe('issue #15: license artifacts', () => {
  it('LICENSE is the complete canonical AGPL-3.0 text', () => {
    const t = read('LICENSE');
    expect(t.startsWith('GNU AFFERO GENERAL PUBLIC LICENSE')).toBe(true);
    expect(t).toContain('Version 3, 19 November 2007');
    // section markers all present, in order — detects truncation
    const markers = [
      'TERMS AND CONDITIONS',
      '1. Source Code.',
      '2. Basic Permissions.',
      '13. Remote Network Interaction; Use with the GNU General Public License.',
      '14. Revised Versions of this License.',
      '15. Disclaimer of Warranty.',
      '16. Limitation of Liability.',
      'How to Apply These Terms to Your New Programs',
      'https://www.gnu.org/licenses/',
    ];
    let at = 0;
    for (const m of markers) {
      const i = t.indexOf(m);
      expect(i).toBeGreaterThan(at);
      at = i;
    }
    expect(t.length).toBeGreaterThan(33_000); // full text ≈ 34k chars
  });

  it('package.json license + version are set and consistent with the server', () => {
    const pkg = JSON.parse(read('package.json')) as { license?: string; version?: string; private?: boolean };
    expect(pkg.license).toBe('AGPL-3.0-or-later');
    expect(pkg.version).toBe('0.8.0');
    // private stays true until the owner publishes — release checklist item
    expect(pkg.private).toBe(true);
    const version = pkg.version ?? '';
    expect(version).not.toBe(''); // version must be set
    const cfg = read('src/config/config.ts');
    expect(cfg).toContain(`.default('${version}')`); // server version synced
  });

  it('NOTICE carries copyright, license reference, third-party census pointer', () => {
    const n = read('NOTICE');
    expect(n).toContain('Copyright (C) 2026 Hugs-4-Bugs');
    expect(n).toContain('GNU Affero General Public License');
    expect(n).toContain('@modelcontextprotocol/server (MIT)');
    expect(n).toContain('pg (MIT)');
    expect(n).toContain('zod (MIT)');
    expect(n).toContain('MPL-2.0');
    expect(n).toContain('release-checklist.test.ts');
  });

  it('dependency census: every locked package has an AGPL-compatible license', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { license?: string; name?: string }>;
    };
    const compatible = new Set([
      'MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause',
      'BlueOak-1.0.0', 'MPL-2.0', '0BSD', 'Unlicense', 'CC0-1.0', 'CC-BY-4.0',
      'Python-2.0', 'Python-2.0.1', 'PostgreSQL', 'BSD-3-Clause-Clear',
    ]);
    const bad: string[] = [];
    let counted = 0;
    for (const [path, p] of Object.entries(lock.packages)) {
      if (path === '') continue;
      counted += 1;
      const lic = (p.license ?? '').replace(/\(.*\)/g, '').trim();
      if (!compatible.has(lic)) bad.push(`${p.name ?? path}: ${p.license ?? 'MISSING'}`);
    }
    expect(counted).toBeGreaterThan(200); // real census, not empty
    expect(bad).toEqual([]);
  });
});

describe('issue #15: governance docs', () => {
  it('CONTRIBUTING defines the gates incl. secret scan and DCO sign-off', () => {
    const c = read('CONTRIBUTING.md');
    expect(c).toContain('npm run typecheck');
    expect(c).toContain('npx vitest run');
    expect(c).toContain('secret-scan');
    expect(c).toContain('Signed-off-by');
    expect(c).toContain('AGPL-3.0-or-later');
  });

  it('CODE_OF_CONDUCT is the Contributor Covenant with enforcement contact', () => {
    const t = read('CODE_OF_CONDUCT.md');
    expect(t).toContain('Contributor Covenant');
    expect(t).toContain('https://www.contributor-covenant.org/version/2/1/code_of_conduct.html');
    expect(t).toContain('Our Pledge');
    expect(t).toContain('Enforcement');
    // the reporting contact must reference the security policy (not a stub)
    expect(t).toContain('SECURITY');
  });

  it('SECURITY policy: private channel, SLA, scope — never "open an issue"', () => {
    const s = read('03_SECURITY/SECURITY_POLICY.md');
    expect(s).toContain('Do not open a public issue');
    expect(s).toContain('72 hours');
    expect(s).toContain('security/advisories');
    expect(s).toContain('Scope');
  });

  it('privacy documentation exists and is non-stub (retention classes + deletion)', () => {
    const d = read('03_SECURITY/DATA_PRIVACY.md');
    expect(d).toContain('Data classes and retention');
    expect(d).toContain('RetentionSweeper');
    expect(d).toContain('Deletion semantics');
    expect(d.length).toBeGreaterThan(1_000);
  });

  it('CHANGELOG covers M1..M8; RELEASE_CHECKLIST covers gates + AGPL §13', () => {
    const ch = read('CHANGELOG.md');
    for (const m of ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.8.0']) {
      expect(ch).toContain(`## [${m}]`);
    }
    const rc = read('RELEASE_CHECKLIST.md');
    expect(rc).toContain('npm audit');
    expect(rc).toContain('secret-scan');
    expect(rc).toContain('Corresponding-source');
    expect(rc).toContain('git tag -s');
  });

  it('README links the license and governance docs', () => {
    const r = read('README.md');
    expect(r).toContain('AGPL-3.0-or-later');
    for (const f of ['LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'RELEASE_CHECKLIST.md', 'CHANGELOG.md']) {
      expect(r).toContain(`[${f}](${f})`);
    }
  });

  it('CI workflow enforces the same gates a human runs', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('npm run typecheck');
    expect(ci).toContain('npm run lint');
    expect(ci).toContain('npm run build');
    expect(ci).toContain('npx vitest run');
    expect(ci).toContain('npm audit');
    expect(ci).toContain('secret-scan.sh');
    expect(ci).toContain("branches: [develop, main]");
  });

  it('all checklist files exist on disk', () => {
    for (const f of [
      'LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
      'CHANGELOG.md', 'RELEASE_CHECKLIST.md', '.github/workflows/ci.yml',
      '03_SECURITY/SECURITY_POLICY.md', '03_SECURITY/DATA_PRIVACY.md',
    ]) {
      expect(existsSync(join(repoRoot, f))).toBe(true);
    }
  });
});
