import { SeedancePromptValidatorService } from '../../../src/video/seedance-prompt-validator.service';

describe('SeedancePromptValidatorService', () => {
  const validator = new SeedancePromptValidatorService();

  it('accepts a well-formed prompt', () => {
    const result = validator.validate(
      '参考 @图片1 中的<主体1>（短发女孩），生成她坐在咖啡店窗边吃蛋糕的画面。高清，细节丰富，电影质感；人物面部稳定不变形、动作连贯自然，无穿模无卡顿；不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('rejects a raw asset ID', () => {
    const result = validator.validate('让 [asset-123] 中的人跑向镜头。');

    expect(result.errors).toContainEqual(expect.stringContaining('asset ID'));
  });

  it('rejects ambiguous asset references followed by actions', () => {
    const result = validator.validate('@图片1跑向画面右侧。');

    expect(result.errors).toContainEqual(expect.stringContaining('紧接动作或方位'));
  });

  it('rejects reference phrasing in a video edit request', () => {
    const result = validator.validate('严格编辑 @视频1，参考 @视频1，将背景替换为海边。');

    expect(result.errors).toContainEqual(expect.stringContaining('编辑或延长任务'));
  });

  it('rejects conflicting camera moves in one shot', () => {
    const result = validator.validate('镜头1：推镜头，主体微笑，随后拉镜头。');

    expect(result.errors).toContainEqual(expect.stringContaining('一种运镜'));
  });

  it('rejects absolute times in multi-shot prompts', () => {
    const result = validator.validate('镜头1：0-3秒，固定镜头。镜头2：3-6秒，跟拍主体。');

    expect(result.errors).toContainEqual(expect.stringContaining('绝对秒数'));
  });

  it('rejects timestamp ranges in multi-shot prompts', () => {
    const result = validator.validate('镜头1：0:00-0:03，固定镜头。镜头2：0:03-0:06，跟拍主体。');

    expect(result.errors).toContainEqual(expect.stringContaining('绝对秒数'));
  });

  it('warns when a multi-subject prompt lacks duplicate-character constraints', () => {
    const result = validator.validate(
      '<主体1> 与 <主体2> 在餐桌旁交谈。高清电影质感，画面稳定无变形，不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toContainEqual(expect.stringContaining('双胞胎'));
  });
});
