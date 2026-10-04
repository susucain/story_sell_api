import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  MUST_CONTAIN_RULES,
  PROHIBITION_RULES,
  SKILL_CLAUSE_COVERAGE,
} from '../../../src/video/seedance-rules';

const SKILL_MD_PATH = path.resolve(
  __dirname,
  '../../../src/video/skills/sd2-pe/SKILL.md',
);

describe('sd2-pe rule registry coverage', () => {
  let skillMd: string;

  const declaredRuleIds = new Set([
    ...MUST_CONTAIN_RULES.map((rule) => rule.id),
    ...Object.keys(PROHIBITION_RULES),
  ]);
  const coveredClauses = new Set(
    SKILL_CLAUSE_COVERAGE.map((item) => item.clause),
  );

  beforeAll(async () => {
    skillMd = await fs.readFile(SKILL_MD_PATH, 'utf8');
  });

  it('covers every bullet of the SKILL.md 强制约束（总览） section', () => {
    const overview = skillMd.split('## 强制约束（总览）')[1] ?? '';
    const bullets = [...overview.matchAll(/^-\s+\*\*(.+?)\*\*/gm)].map(
      (match) => match[1],
    );

    expect(bullets.length).toBeGreaterThan(0);
    expect(bullets.filter((title) => !coveredClauses.has(title))).toEqual([]);
  });

  it('covers the mandatory SKILL.md sections', () => {
    for (const clause of [
      '无文字画面（最高优先级）',
      '特殊字符规范（强制使用）',
    ]) {
      expect(skillMd).toContain(`## ${clause}`);
      expect(coveredClauses.has(clause)).toBe(true);
    }
  });

  it('maps every declared rule to an existing coverage clause', () => {
    for (const rule of [
      ...MUST_CONTAIN_RULES,
      ...Object.values(PROHIBITION_RULES),
    ]) {
      expect(coveredClauses.has(rule.skillClause)).toBe(true);
    }
  });

  it('references only declared rule ids from coverage entries', () => {
    for (const entry of SKILL_CLAUSE_COVERAGE) {
      for (const id of entry.rules) {
        expect(declaredRuleIds.has(id)).toBe(true);
      }
      if (entry.rules.length === 0) {
        expect(entry.advisoryReason).toBeTruthy();
      }
    }
  });

  it('leaves no declared rule unreferenced by coverage entries', () => {
    const referenced = new Set(
      SKILL_CLAUSE_COVERAGE.flatMap((entry) => entry.rules),
    );

    expect([...declaredRuleIds].filter((id) => !referenced.has(id))).toEqual(
      [],
    );
  });
});
