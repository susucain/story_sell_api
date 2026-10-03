import {
  ANTI_DIRTY_QUALITY_PREFIX,
  buildSegmentPrompt,
  SEGMENT_CONTINUITY_LINE,
  splitSeedancePrompt,
} from '../../../src/video/video-segment-prompt';
import type { PlannedSegment } from '../../../src/video/video-segment-planner';

const seedancePrompt = [
  '9:16 竖屏，生活服务场景，<主体1>为短发女性，穿米色风衣。',
  '',
  '镜头1：清晨的厨房',
  '画面：<主体1>推开门走进厨房，顺手打开灯',
  '旁白{今天早餐吃点什么好}',
  '',
  '镜头2：餐桌特写',
  '画面：<主体1>把面包放进烤箱，固定机位',
  '旁白{三分钟就能搞定}',
].join('\n');

function segment(
  index: number,
  shots: Array<{ shot: number; ordinal: number }>,
): PlannedSegment {
  return {
    index,
    startSec: (index - 1) * 15,
    endSec: index * 15,
    duration: 15,
    shots: shots.map((item) => ({
      shot: item.shot,
      ordinal: item.ordinal,
      scene: `场景${item.shot}`,
      visual: `画面${item.shot}`,
      audio: `台词${item.shot}`,
      continues: false,
    })),
  };
}

describe('splitSeedancePrompt', () => {
  it('separates the global setting from numbered shot blocks', () => {
    const { preamble, blocks } = splitSeedancePrompt(seedancePrompt);

    expect(preamble).toContain('<主体1>为短发女性');
    expect(preamble).not.toContain('镜头1');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('镜头1');
    expect(blocks[1]).toContain('镜头2');
  });

  it('returns the whole text as preamble when no shot block exists', () => {
    const { preamble, blocks } =
      splitSeedancePrompt('只有全局设定，没有镜头块');
    expect(blocks).toHaveLength(0);
    expect(preamble).toBe('只有全局设定，没有镜头块');
  });
});

describe('buildSegmentPrompt', () => {
  it('builds an extend prompt that references the previous video only', () => {
    const prompt = buildSegmentPrompt({
      title: '早餐教程',
      meta: { ratio: '9:16', style: '清新明亮' },
      seedancePrompt,
      scriptShotCount: 2,
      segment: segment(2, [{ shot: 2, ordinal: 1 }]),
      totalSegments: 2,
      continuityMode: 'extend',
    });

    expect(prompt).toContain('向后延长 @视频1');
    expect(prompt).not.toContain('@图片1');
    expect(prompt).toContain(SEGMENT_CONTINUITY_LINE.extend);
    expect(prompt).toContain('第 2/2 段');
    expect(prompt).toContain('镜头2');
    expect(prompt).toContain('固定机位');
    expect(prompt).not.toContain('镜头1');
    expect(prompt).not.toContain(ANTI_DIRTY_QUALITY_PREFIX);
  });

  it('builds a frame bridge prompt that pins the first frame and keeps the anti-dirty quality prefix', () => {
    const prompt = buildSegmentPrompt({
      title: '早餐教程',
      meta: { ratio: '9:16' },
      seedancePrompt,
      scriptShotCount: 2,
      segment: segment(2, [{ shot: 2, ordinal: 1 }]),
      totalSegments: 2,
      continuityMode: 'frame_bridge',
    });

    expect(prompt.startsWith(ANTI_DIRTY_QUALITY_PREFIX)).toBe(true);
    expect(prompt).toContain('@图片1 作为首帧约束');
    expect(prompt).not.toContain('@视频1');
    expect(prompt).toContain(SEGMENT_CONTINUITY_LINE.frame_bridge);
  });

  it('reuses the global setting in every segment', () => {
    const prompt = buildSegmentPrompt({
      title: '早餐教程',
      meta: {},
      seedancePrompt,
      scriptShotCount: 2,
      segment: segment(1, [{ shot: 1, ordinal: 0 }]),
      totalSegments: 2,
      continuityMode: 'extend',
    });

    expect(prompt).toContain('<主体1>为短发女性');
  });

  it('falls back to storyboard shot data when block count does not match', () => {
    const prompt = buildSegmentPrompt({
      title: '早餐教程',
      meta: {},
      seedancePrompt,
      scriptShotCount: 5,
      segment: segment(1, [{ shot: 1, ordinal: 0 }]),
      totalSegments: 2,
      continuityMode: 'extend',
    });

    expect(prompt).toContain('镜头1：场景1');
    expect(prompt).toContain('旁白{台词1}');
    expect(prompt).toContain('9:16 竖屏，生活服务场景');
  });
});
