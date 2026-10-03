import type { VideoContinuityMode } from './entities/video-generation-plan.entity';
import type { PlannedSegment } from './video-segment-planner';

/** 首帧约束模式下置顶的抗脏画质包（首帧画质直接决定整段画质） */
export const ANTI_DIRTY_QUALITY_PREFIX =
  '高码率高清画质，低噪点无颗粒雪花，画面干净通透，无脏斑色块；人物皮肤哑光无油光无反光，面部色彩均匀；暗部干净无杂色，动态流畅无拖影。';

/** 段与段之间的衔接要求，随衔接方式不同 */
export const SEGMENT_CONTINUITY_LINE: Record<VideoContinuityMode, string> = {
  extend:
    '从头衔接上一段画面，保持人物造型、服装、场景、光线、构图与运镜风格完全一致，动作连贯承接，气口自然。',
  frame_bridge:
    '从首帧画面自然延续，保持人物造型、服装、场景、光线、构图与运镜风格与首帧完全一致。',
};

const MODE_HEADER: Record<VideoContinuityMode, string> = {
  extend: '向后延长 @视频1，接续生成第 {index} 段内容。',
  frame_bridge: '@图片1 作为首帧约束，接续生成第 {index} 段内容。',
};

export interface SegmentPromptParams {
  title: string;
  meta?: Record<string, any> | null;
  /** 脚本级别的完整提示词，用于抽取全局设定与镜头块 */
  seedancePrompt?: string | null;
  /** 脚本镜头总数，用于判断能否按序号复用原始镜头块 */
  scriptShotCount: number;
  segment: PlannedSegment;
  totalSegments: number;
  continuityMode: VideoContinuityMode;
}

interface SplitSeedancePrompt {
  preamble: string;
  blocks: string[];
}

/** 把整脚本提示词拆成「全局设定 + 各镜头块」，镜头块按序号与 storyboard 镜头一一对应 */
export function splitSeedancePrompt(
  prompt: string | null | undefined,
): SplitSeedancePrompt {
  const text = (prompt ?? '').replace(/\r\n/g, '\n');
  const matched = text.match(/镜头\s*\d+[\s\S]*?(?=镜头\s*\d+|$)/g);
  const blocks: string[] = matched ? Array.from(matched) : [];
  if (blocks.length === 0) {
    return { preamble: text.trim(), blocks: [] };
  }

  const firstBlock = blocks[0];
  if (firstBlock === undefined) {
    return { preamble: text.trim(), blocks: [] };
  }

  const firstBlockIndex = text.indexOf(firstBlock);
  return {
    preamble: text.slice(0, firstBlockIndex).trim(),
    blocks: blocks.map((block) => block.trim()),
  };
}

/** 由脚本 meta 拼出跨段复用的人物与风格设定 */
function renderGlobalSetting(
  title: string,
  meta?: Record<string, any> | null,
): string {
  const lines: string[] = [];
  if (title) lines.push(`视频主题：${title}`);
  if (meta?.style) lines.push(`视觉风格：${meta.style}`);
  if (meta?.ratio) lines.push(`画幅比例：${meta.ratio}`);

  const character = meta?.character as
    | {
        mode?: string;
        roleName?: string;
        rolePrompt?: string;
        outfit?: { customPrompt?: string };
      }
    | undefined;
  if (character && character.mode && character.mode !== 'none') {
    const parts = [
      character.roleName,
      character.rolePrompt,
      character.outfit?.customPrompt,
    ].filter((value): value is string =>
      Boolean(value && String(value).trim()),
    );
    if (parts.length > 0) {
      lines.push(`角色设定：${parts.join('，')}，各段保持同一人物造型与服装。`);
    }
  }

  return lines.join('\n');
}

/** 按 storyboard 镜头数据兜底渲染单个镜头块（原始提示词镜头上数量不匹配时使用） */
function renderShotFallback(shot: {
  shot: number;
  scene: string;
  visual: string;
  audio: string;
  continues: boolean;
}): string {
  const lines = [
    `镜头${shot.shot}：${shot.scene}${shot.continues ? '（延续上一段同一镜头）' : ''}`,
  ];
  if (shot.visual) lines.push(`画面：${shot.visual}`);
  if (shot.audio) lines.push(`旁白{${shot.audio}}`);
  return lines.join('\n');
}

/**
 * 生成单段提示词：复用脚本级全局设定与原始镜头块，只保留本段镜头，
 * 并显式写明与上一段的衔接要求，避免拼接后画面/人物/风格跳变。
 */
export function buildSegmentPrompt(params: SegmentPromptParams): string {
  const { segment, continuityMode, totalSegments } = params;
  const sections: string[] = [];

  if (continuityMode === 'frame_bridge') {
    sections.push(ANTI_DIRTY_QUALITY_PREFIX);
  }

  sections.push(
    MODE_HEADER[continuityMode].replace('{index}', String(segment.index)),
    `本段为第 ${segment.index}/${totalSegments} 段，只生成下列镜头内容。`,
    SEGMENT_CONTINUITY_LINE[continuityMode],
  );

  const globalSetting = renderGlobalSetting(params.title, params.meta);
  if (globalSetting) sections.push(globalSetting);

  const { preamble, blocks } = splitSeedancePrompt(params.seedancePrompt);
  const reusableBlocks =
    blocks.length > 0 && blocks.length === params.scriptShotCount;
  if (preamble) sections.push(preamble);

  const shotSections = segment.shots.map((shot) =>
    reusableBlocks && blocks[shot.ordinal]
      ? blocks[shot.ordinal]
      : renderShotFallback(shot),
  );
  sections.push(...shotSections);

  return sections.filter((section) => section.trim().length > 0).join('\n\n');
}
