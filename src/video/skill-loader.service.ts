import { Injectable } from '@nestjs/common';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SkillMeta {
  name: string;
  description: string;
  trigger: string;
}

export class SkillNotFoundError extends Error {
  readonly code = 'SKILL_NOT_FOUND';

  constructor(skillName: string) {
    super(`未知 video skill：${skillName}`);
    this.name = 'SkillNotFoundError';
  }
}

const SKILL_ENTRY_FILE = 'SKILL.md';
const REFERENCES_DIR = 'references';

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

@Injectable()
export class SkillLoaderService {
  private readonly skillsDir = process.env.SKILLS_DIR
    ? path.resolve(process.env.SKILLS_DIR)
    : path.resolve(process.cwd(), 'src/video/skills');

  /** 扫描 skills 目录，返回所有声明了 SKILL.md 的技能元信息。 */
  async listSkills(): Promise<SkillMeta[]> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const metas = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await this.loadMeta(entry.name);
          } catch {
            return null;
          }
        }),
    );
    return metas.filter((meta): meta is SkillMeta => meta !== null);
  }

  /** 按目录名加载技能元信息，未知技能抛出 SkillNotFoundError。 */
  async loadMeta(skillName: string): Promise<SkillMeta> {
    const content = await this.readSkillFile(skillName, SKILL_ENTRY_FILE);
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
      return { name: '', description: '', trigger: '' };
    }
    const frontmatter = match[1];
    return {
      name: this.extractField(frontmatter, 'name'),
      description: this.extractField(frontmatter, 'description'),
      trigger: this.extractField(frontmatter, 'trigger'),
    };
  }

  /** 扫描指定技能的 references 目录，返回不带扩展名的参考文件名称。 */
  async listReferences(skillName: string): Promise<string[]> {
    const referencesDir = this.resolveInsideSkills(skillName, REFERENCES_DIR);
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(referencesDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -'.md'.length))
      .sort();
  }

  /** 读取指定技能下某个参考文件的完整内容。 */
  async loadReference(
    skillName: string,
    referenceName: string,
  ): Promise<string> {
    const references = await this.listReferences(skillName);
    if (!references.includes(referenceName)) {
      throw new Error(`未知 video reference：${referenceName}`);
    }
    return this.readSkillFile(
      skillName,
      path.join(REFERENCES_DIR, `${referenceName}.md`),
    );
  }

  private async readSkillFile(
    skillName: string,
    relativePath: string,
  ): Promise<string> {
    const fullPath = this.resolveInsideSkills(skillName, relativePath);
    try {
      return await fs.readFile(fullPath, 'utf-8');
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new SkillNotFoundError(skillName);
      }
      throw error;
    }
  }

  /** 解析 skills 目录内的路径，越界的技能名一律视为未找到。 */
  private resolveInsideSkills(...segments: string[]): string {
    const fullPath = path.resolve(this.skillsDir, ...segments);
    const root = this.skillsDir.endsWith(path.sep)
      ? this.skillsDir
      : `${this.skillsDir}${path.sep}`;
    if (!fullPath.startsWith(root)) {
      throw new SkillNotFoundError(segments[0] ?? '');
    }
    return fullPath;
  }

  private extractField(frontmatter: string, key: string): string {
    const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    const match = frontmatter.match(regex);
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  }
}