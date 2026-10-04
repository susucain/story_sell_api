import { SkillLoaderService } from '../../../src/video/skill-loader.service';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('SkillLoaderService', () => {
  const originalSkillsDir = process.env.SKILLS_DIR;

  afterEach(() => {
    if (originalSkillsDir === undefined) {
      delete process.env.SKILLS_DIR;
    } else {
      process.env.SKILLS_DIR = originalSkillsDir;
    }
  });

  it('discovers every skill that declares a SKILL.md', async () => {
    const loader = new SkillLoaderService();
    const registry = await loader.listSkills();

    expect(registry.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(['life-service-storyboard-generator', 'sd2-pe']),
    );
  });

  it('lists the references bundled with a skill', async () => {
    const loader = new SkillLoaderService();
    const references = await loader.listReferences(
      'life-service-storyboard-generator',
    );

    expect(references).toEqual(
      expect.arrayContaining([
        'routing',
        'character',
        'storyboard',
        'seedance',
      ]),
    );
  });

  it('lists the references bundled with sd2-pe', async () => {
    const loader = new SkillLoaderService();
    const references = await loader.listReferences('sd2-pe');

    expect(references).toEqual(
      expect.arrayContaining([
        'seedance-2-troubleshooting-guide',
        'typical-effect-cases',
      ]),
    );
  });

  it('returns no references for a skill without a references directory', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'video-skills-'));
    const skillDir = join(skillsDir, 'bare-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: bare-skill\ndescription: test\ntrigger: always\n---\nContent',
    );
    process.env.SKILLS_DIR = skillsDir;

    try {
      const loader = new SkillLoaderService();
      await expect(loader.listReferences('bare-skill')).resolves.toEqual([]);
    } finally {
      await rm(skillsDir, { recursive: true, force: true });
    }
  });

  it('loads a skill by its directory name', async () => {
    const loader = new SkillLoaderService();

    await expect(
      loader.loadMeta('life-service-storyboard-generator'),
    ).resolves.toMatchObject({ name: 'life-service-storyboard-generator' });
  });

  it('loads the Seedance prompt optimizer by name', async () => {
    const loader = new SkillLoaderService();
    const meta = await loader.loadMeta('sd2-pe');

    expect(meta.name).toBe('sd2-pe');
  });

  it('raises a typed error for an unknown skill name', async () => {
    const loader = new SkillLoaderService();

    await expect(loader.loadMeta('missing-skill')).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
  });

  it('rejects skill names that escape the skills directory', async () => {
    const loader = new SkillLoaderService();

    await expect(loader.loadMeta('../secret')).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
    });
  });

  it.each(['routing', 'character', 'storyboard', 'seedance'])(
    'loads the %s reference for a skill',
    async (referenceName) => {
      const loader = new SkillLoaderService();

      await expect(
        loader.loadReference(
          'life-service-storyboard-generator',
          referenceName,
        ),
      ).resolves.toContain('#');
    },
  );

  it('rejects unknown and traversal reference names', async () => {
    const loader = new SkillLoaderService();
    const skill = 'life-service-storyboard-generator';

    await expect(loader.loadReference(skill, 'missing')).rejects.toThrow(
      '未知 video reference',
    );
    await expect(loader.loadReference(skill, '../SKILL')).rejects.toThrow(
      '未知 video reference',
    );
    await expect(loader.loadReference(skill, 'toString')).rejects.toThrow(
      '未知 video reference',
    );
  });

  it('loads skills from SKILLS_DIR in production', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'video-skills-'));
    const skillDir = join(skillsDir, 'life-service-storyboard-generator');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: production-skill\ndescription: test\ntrigger: always\n---\nContent',
    );
    process.env.SKILLS_DIR = skillsDir;

    try {
      const loader = new SkillLoaderService();
      await expect(
        loader.loadMeta('life-service-storyboard-generator'),
      ).resolves.toMatchObject({ name: 'production-skill' });
    } finally {
      await rm(skillsDir, { recursive: true, force: true });
    }
  });
});
