import { StoryboardParserService } from '../../../src/video/storyboard-parser.service';

const LIFE_SERVICE_SAMPLE = [
  '# 探店视频',
  '',
  '**总时长**：12秒',
  '**画幅**：9:16',
  '**视频类型**：抖音',
  '',
  '### 镜头 1：开场钩子 (0s - 3s)',
  '- **画面描述**：门店招牌特写',
  '- **旁白**：这家店排队排疯了',
  '',
  '### 镜头 2：套餐展示 (3s - 12s)',
  '- **画面描述**：双人套餐上桌',
  '- **旁白**：双人餐只要 99',
].join('\n');

const NARRATIVE_SAMPLE = [
  '# 夜跑',
  '',
  '### 场景 1：江边夜跑 (0s - 6s)',
  '- **场景标题**：EXT. 江边跑道 - 夜',
  '- **画面描述**：主角沿江慢跑，霓虹倒映在水面',
  '- **对白**：今晚的风真好',
].join('\n');

const PLAIN_SAMPLE = [
  '# 随便一个脚本',
  '',
  '### 镜头 1：开头 (0s - 5s)',
  '- **画面描述**：画面',
].join('\n');

describe('StoryboardParserService', () => {
  const service = new StoryboardParserService();

  it('parses the life-service shot format', () => {
    const parsed = service.parse(LIFE_SERVICE_SAMPLE, {
      vertical: 'life-service',
    });

    expect(parsed.shots.length).toBeGreaterThan(0);
    expect(parsed.shots[0].time).toBe('0-3s');
    expect(parsed.shots[0].scene).toBe('开场钩子');
    expect(parsed.shots[0].audio).toContain('排队');
    expect(parsed.shots[0].sceneHeading).toBeUndefined();
  });

  it('parses the narrative-shot format', () => {
    const parsed = service.parse(NARRATIVE_SAMPLE, { vertical: 'narrative' });

    expect(parsed.shots.length).toBeGreaterThan(0);
    expect(parsed.shots[0]).toHaveProperty('sceneHeading');
    expect(parsed.shots[0].sceneHeading).toBe('EXT. 江边跑道 - 夜');
    expect(parsed.shots[0].audio).toContain('风真好');
  });

  it('defaults to the life-service strategy when no vertical is given', () => {
    const parsed = service.parse(LIFE_SERVICE_SAMPLE);

    expect(parsed.shots).toHaveLength(2);
    expect(parsed.shots[0].sceneHeading).toBeUndefined();
  });

  it('falls back to the life-service strategy for an unknown vertical', () => {
    const parsed = service.parse(LIFE_SERVICE_SAMPLE, {
      vertical: 'not-a-vertical',
    });

    expect(parsed.shots).toHaveLength(2);
  });

  it('applies vertical-specific meta defaults', () => {
    const narrative = service.parse(NARRATIVE_SAMPLE, {
      vertical: 'narrative',
    });
    const plain = service.parse(PLAIN_SAMPLE);

    expect(narrative.meta.duration).toBe(30);
    expect(narrative.meta.ratio).toBe('16:9');
    expect(plain.meta.duration).toBe(15);
    expect(plain.meta.ratio).toBe('9:16');
    expect(plain.meta.platform).toBe('抖音/小红书');
  });

  it('extracts the title and hook from the first shot', () => {
    const parsed = service.parse(LIFE_SERVICE_SAMPLE);

    expect(parsed.title).toBe('探店视频');
    expect(parsed.hook).toBe('开场钩子');
  });
});