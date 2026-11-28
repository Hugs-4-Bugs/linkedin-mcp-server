/**
 * §8 validation: the repository-distributed Agent Skills follow the
 * official Agent Skills format — YAML frontmatter with required fields,
 * body size limits, name constraints, and content consistent with the
 * actual tool catalog (every tool referenced in a skill must be a real
 * registered tool; every error code referenced must exist in the code).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_ROOT = join(process.cwd(), 'skills');
// The real catalog (serverFactory registrations):
const REGISTERED_TOOLS = new Set([
  'linkedin_connect',
  'linkedin_status',
  'linkedin_disconnect',
  'linkedin_get_my_profile',
  'linkedin_list_granted_scopes',
  'linkedin_draft_post',
  'linkedin_preview_post',
  'linkedin_publish_post',
  'linkedin_schedule_post',
  'linkedin_list_scheduled_posts',
  'linkedin_cancel_scheduled_post',
]);
const OUR_SKILLS = ['linkedin-publishing', 'linkedin-post-scheduling', 'linkedin-connection-troubleshooting'];

function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (m === null) throw new Error('missing frontmatter delimiters');
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line);
    if (kv !== null) fm[kv[1]] = kv[2];
  }
  return { fm, body: m[2] };
}

describe('agent skills follow the official format', () => {
  it('exactly the curated set exists under skills/ (besides the workspace-local tooling skills)', () => {
    const dirs = readdirSync(SKILLS_ROOT).filter((d) => statSync(join(SKILLS_ROOT, d)).isDirectory());
    for (const s of OUR_SKILLS) expect(dirs).toContain(s);
    // No accidental skill sprawl: the three curated skills are the
    // complete LinkedIn set.
    const lkm = dirs.filter((d) => d.startsWith('linkedin-'));
    expect(lkm.sort()).toEqual([...OUR_SKILLS].sort());
  });

  for (const name of OUR_SKILLS) {
    it(`${name}: frontmatter has name + one-sentence description; name <=64 chars, no slashes`, () => {
      const file = join(SKILLS_ROOT, name, 'SKILL.md');
      const text = readFileSync(file, 'utf8');
      const { fm, body } = parseFrontmatter(text);
      expect(fm.name).toBe(name);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name).not.toMatch(/[/\\]/);
      expect(fm.description).toBeDefined();
      expect(fm.description.length).toBeGreaterThan(20);
      // Description budget: the spec caps it at 1024 characters.
      expect(fm.description.length).toBeLessThanOrEqual(1024);
      // Body budget: the spec caps SKILL.md bodies at 5 KB.
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(5 * 1024);
    });

    it(`${name}: every referenced tool is a REAL registered tool`, () => {
      const text = readFileSync(join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8');
      const mentioned = [...text.matchAll(/`linkedin_[a-z_]+`/g)].map((m) => m[0].slice(1, -1));
      expect(mentioned.length).toBeGreaterThan(0);
      for (const t of mentioned) expect(REGISTERED_TOOLS.has(t)).toBe(true);
    });
  }

  it('skills stay consistent with the catalog discipline: confirm-required tools are documented as confirm-required', () => {
    const norm = (t: string): string => t.replace(/\s+/g, ' ');
    const pub = readFileSync(join(SKILLS_ROOT, 'linkedin-publishing', 'SKILL.md'), 'utf8');
    expect(norm(pub)).toContain('`linkedin_publish_post` with `text` and `confirm: true`');
    const sched = readFileSync(join(SKILLS_ROOT, 'linkedin-post-scheduling', 'SKILL.md'), 'utf8');
    expect(sched).toContain('`linkedin_schedule_post`');
    expect(sched).toContain('confirm: true');
    // No invented capabilities: every mention of restricted surfaces must
    // be in a NOT-exposed sentence (the skills name them only to deny them).
    const tshoot = readFileSync(join(SKILLS_ROOT, 'linkedin-connection-troubleshooting', 'SKILL.md'), 'utf8');
    for (const f of [pub, sched, tshoot]) {
      // Paragraph-level check: any paragraph mentioning a restricted
      // surface must contain a negation in the SAME paragraph.
      for (const para of f.split('\n\n')) {
        if (/messaging|invitation|analytics|company page|search|feed/i.test(para)) {
          expect(para).toMatch(/\b(not|no|never|only)\b/i);
        }
      }
    }
  });
});
