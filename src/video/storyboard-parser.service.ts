import { Injectable } from '@nestjs/common';
import { DEFAULT_VERTICAL_ID } from './vertical-profile.registry';

export interface Shot {
  shot: number;
  time: string;
  scene: string;
  visual: string;
  audio: string;
  /** 叙事型分镜的场次标题，例如 "EXT. 江边跑道 - 夜" */
  sceneHeading?: string;
}

export interface ParsedStoryboard {
  title: string;
  hook: string;
  meta: {
    duration: number;
    ratio: string;
    style: string;
    platform: string;
  };
  shots: Shot[];
}

export interface StoryboardParseOptions {
  /** 目标垂类，决定采用哪套分镜解析策略；缺省或未知时使用 life-service */
  vertical?: string;
}

interface StoryboardStrategy {
  defaultMeta: ParsedStoryboard['meta'];
  extractShots(markdown: string): Shot[];
}

interface ShotBlockOptions {
  /** 场次标题字段名，life-service 无该字段 */
  sceneHeadingKey?: string;
  /** 音频字段名，按顺序取第一个命中的 */
  audioKeys: string[];
}

const LIFE_SERVICE_DEFAULT_META: ParsedStoryboard['meta'] = {
  duration: 15,
  ratio: '9:16',
  style: '',
  platform: '抖音/小红书',
};

const NARRATIVE_DEFAULT_META: ParsedStoryboard['meta'] = {
  duration: 30,
  ratio: '16:9',
  style: '',
  platform: '',
};

@Injectable()
export class StoryboardParserService {
  private readonly strategies: Record<string, StoryboardStrategy> = {
    [DEFAULT_VERTICAL_ID]: {
      defaultMeta: LIFE_SERVICE_DEFAULT_META,
      extractShots: (markdown) =>
        this.extractShotBlocks(markdown, '镜头', { audioKeys: ['旁白'] }),
    },
    narrative: {
      defaultMeta: NARRATIVE_DEFAULT_META,
      extractShots: (markdown) =>
        this.extractShotBlocks(markdown, '场景', {
          sceneHeadingKey: '场景标题',
          audioKeys: ['对白', '旁白'],
        }),
    },
  };

  parse(
    markdown: string,
    options: StoryboardParseOptions = {},
  ): ParsedStoryboard {
    const strategy = this.resolveStrategy(options.vertical);
    const lines = markdown.split('\n');
    const title = this.extractTitle(lines);
    const meta = this.extractMeta(lines, strategy.defaultMeta);
    const shots = strategy.extractShots(markdown);
    const hook = shots[0]?.scene ?? '';

    return {
      title,
      hook,
      meta,
      shots,
    };
  }

  private resolveStrategy(vertical?: string): StoryboardStrategy {
    if (vertical && Object.hasOwn(this.strategies, vertical)) {
      return this.strategies[vertical];
    }
    return this.strategies[DEFAULT_VERTICAL_ID];
  }

  private extractTitle(lines: string[]): string {
    const firstHeading = lines.find((line) => line.startsWith('# '));
    return firstHeading ? firstHeading.replace('# ', '').trim() : '';
  }

  private extractMeta(
    lines: string[],
    defaults: ParsedStoryboard['meta'],
  ): ParsedStoryboard['meta'] {
    const meta: ParsedStoryboard['meta'] = { ...defaults };

    for (const line of lines) {
      // 兼容 "**时长**：15秒"、"- **时长**：15秒"、"> - **时长**：15秒" 等写法
      const normalized = line.trim().replace(/^[>\-*\s]+/, '');
      const readValue = (key: string): string | null => {
        if (!normalized.startsWith(`**${key}**`)) return null;
        const value = normalized
          .slice(key.length + 4)
          .replace(/^[:：]\s*/, '')
          .trim();
        return value || null;
      };

      const durationText = readValue('总时长') ?? readValue('时长');
      if (durationText) {
        const match = durationText.match(/(\d+(?:\.\d+)?)\s*秒/);
        if (match) meta.duration = Number(match[1]);
      }

      const ratioText = readValue('画幅') ?? readValue('比例');
      if (ratioText) {
        if (ratioText.includes('9:16')) meta.ratio = '9:16';
        else if (ratioText.includes('16:9')) meta.ratio = '16:9';
        else if (ratioText.includes('1:1')) meta.ratio = '1:1';
      }

      const styleText = readValue('视觉风格') ?? readValue('风格');
      if (styleText) meta.style = styleText;

      const typeText = readValue('视频类型');
      if (typeText) {
        if (typeText.includes('抖音')) meta.platform = '抖音';
        else if (typeText.includes('小红书')) meta.platform = '小红书';
      }
    }

    return meta;
  }

  private extractShotBlocks(
    markdown: string,
    headingWord: string,
    options: ShotBlockOptions,
  ): Shot[] {
    const shots: Shot[] = [];
    const headingPattern = new RegExp(`###\\s+${headingWord}\\s*\\d+`);
    const shotBlocks = markdown
      .split(new RegExp(`(?=###\\s+${headingWord}\\s*\\d+)`))
      .filter((block) => headingPattern.test(block.trim()));

    for (const block of shotBlocks) {
      const shotMatch = block.match(
        new RegExp(
          `###\\s+${headingWord}\\s*(\\d+)\\s*[:：]\\s*(.+?)\\s*(?:\\(|$)`,
          'm',
        ),
      );
      const timeMatch = block.match(
        /\((\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-~]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*\)/,
      );

      if (shotMatch && timeMatch) {
        const scene = shotMatch[2].trim();
        const shot: Shot = {
          shot: Number(shotMatch[1]),
          time: `${timeMatch[1]}-${timeMatch[2]}s`,
          scene,
          visual: this.readBlockField(block, '画面描述') ?? scene,
          audio: this.readAudio(block, options.audioKeys),
        };
        if (options.sceneHeadingKey) {
          shot.sceneHeading =
            this.readBlockField(block, options.sceneHeadingKey) ?? '';
        }
        shots.push(shot);
      }
    }

    return shots;
  }

  private readBlockField(block: string, key: string): string | null {
    const match = block.match(
      new RegExp(
        `-\\s*\\*\\*${key}\\*\\*\\s*[:：]\\s*([\\s\\S]*?)(?=\\n-\\s*\\*\\*|\\n---|$)`,
      ),
    );
    return match ? match[1].trim() : null;
  }

  private readAudio(block: string, keys: string[]): string {
    for (const key of keys) {
      const value = this.readBlockField(block, key);
      if (value) return value;
    }
    return '';
  }
}