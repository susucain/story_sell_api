import { SeedancePromptValidatorService } from '../../../src/video/seedance-prompt-validator.service';

describe('SeedancePromptValidatorService', () => {
  const validator = new SeedancePromptValidatorService();

  it('accepts a well-formed prompt', () => {
    const result = validator.validate(
      '参考 @图片1 中的<主体1>（短发女孩），生成她坐在咖啡店窗边吃蛋糕的画面。高清，细节丰富，电影质感；人物面部稳定不变形、动作连贯自然，无穿模无卡顿；保持无字幕，避免生成任何文字或字幕；不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('rejects a raw asset ID', () => {
    const result = validator.validate('让 [asset-123] 中的人跑向镜头。');

    expect(result.errors).toContainEqual(expect.stringContaining('asset ID'));
  });

  it('replaces a known asset ID with the image reference during normalization', () => {
    const result = validator.normalize(
      '让 [asset-20260720212016-qfsgq] 中的人物跑向镜头。',
      { assetIdReplacements: { 'asset-20260720212016-qfsgq': '@图片1' } },
    );

    expect(result.prompt).toContain('@图片1 中的人物');
    expect(result.prompt).not.toContain('asset-');
    expect(result.changes).toContainEqual(
      expect.stringContaining('asset-20260720212016-qfsgq'),
    );
  });

  it('still rejects asset IDs that were not replaced', () => {
    const normalized = validator.normalize('让 [asset-123] 中的人跑向镜头。', {
      assetIdReplacements: { 'asset-20260720212016-qfsgq': '@图片1' },
    });
    const result = validator.validate(normalized.prompt);

    expect(result.errors).toContainEqual(expect.stringContaining('asset ID'));
  });

  it('warns on ambiguous asset references followed by actions', () => {
    const result = validator.validate('@图片1跑向画面右侧。');

    expect(result.warnings).toContainEqual(
      expect.stringContaining('紧接动作或方位'),
    );
  });

  it('rejects reference phrasing in a video edit request', () => {
    const result = validator.validate('严格编辑 @视频1，参考 @视频1，将背景替换为海边。');

    expect(result.errors).toContainEqual(expect.stringContaining('编辑或延长任务'));
  });

  it('warns on conflicting camera moves in one shot', () => {
    const result = validator.validate('镜头1：推镜头，主体微笑，随后拉镜头。');

    expect(result.warnings).toContainEqual(expect.stringContaining('一种运镜'));
  });

  it('does not treat action words as conflicting camera moves', () => {
    const result = validator.validate(
      '镜头1：<主体1> 双手推开大门，随后身体左右摇摆。高清电影质感，画面稳定无变形，保持无字幕，避免生成任何文字或字幕，不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toEqual([]);
  });

  it('does not treat synonyms of the same camera move as conflicting', () => {
    const result = validator.validate(
      '镜头1：移镜头横向展开，等同平移。高清电影质感，画面稳定无变形，保持无字幕，避免生成任何文字或字幕，不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toEqual([]);
  });

  it('warns on absolute times in multi-shot prompts', () => {
    const result = validator.validate('镜头1：0-3秒，固定镜头。镜头2：3-6秒，跟拍主体。');

    expect(result.warnings).toContainEqual(expect.stringContaining('绝对秒数'));
  });

  it('warns on timestamp ranges in multi-shot prompts', () => {
    const result = validator.validate('镜头1：0:00-0:03，固定镜头。镜头2：0:03-0:06，跟拍主体。');

    expect(result.warnings).toContainEqual(expect.stringContaining('绝对秒数'));
  });

  it('routes hard rules to errors and soft rules to warnings', () => {
    const result = validator.validate(
      '镜头1：推镜头后立即拉镜头，画面出现写有“限时特惠”的手牌。高清电影质感，画面稳定无变形，保持无字幕，避免生成任何文字或字幕，不要生成水印，不要生成 Logo。',
    );

    expect(result.warnings).toContainEqual(expect.stringContaining('一种运镜'));
    expect(result.errors).toContainEqual(expect.stringContaining('画面文字'));
  });

  it('rejects a prompt without the no-text constraint', () => {
    const result = validator.validate(
      '生成女孩在咖啡店吃蛋糕的画面。高清，细节丰富，电影质感；人物面部稳定不变形、动作连贯自然，无穿模无卡顿；不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toContainEqual(expect.stringContaining('无字幕'));
  });

  it('accepts equivalent no-text wording', () => {
    const result = validator.validate(
      '生成女孩在咖啡店吃蛋糕的画面。高清，细节丰富，电影质感；人物面部稳定不变形、动作连贯自然，无穿模无卡顿；全程无字幕，禁止生成任何文字或字幕；不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toEqual([]);
  });

  it('normalizes a prompt that omits the no-text constraint', () => {
    const normalized = validator.normalize(
      '生成女孩在咖啡店吃蛋糕的画面。高清，细节丰富，电影质感；人物面部稳定不变形、动作连贯自然，无穿模无卡顿；不要生成水印，不要生成 Logo。',
    );

    expect(normalized.changes).toContain('已补齐无文字画面约束');
    expect(normalized.prompt).toContain('保持无字幕，避免生成任何文字或字幕');
    expect(validator.validate(normalized.prompt).errors).toEqual([]);
  });

  it('normalizes absolute times out of multi-shot Seedance prompts before saving', () => {
    const normalized = validator.normalize(
      '镜头1：0-3秒，固定镜头，展示菜品。镜头2：0:03-0:06，跟拍主体。高清，保持无字幕，避免生成任何文字或字幕。',
    );

    expect(normalized.changes).toContain('已删除多镜头绝对时间码');
    expect(normalized.prompt).not.toMatch(/0-3秒|0:03-0:06/);
    expect(validator.validate(normalized.prompt).errors).toEqual([]);
  });

  it('accepts negative instructions that prohibit visual text', () => {
    const result = validator.validate(
      '生成女孩在咖啡店吃蛋糕的画面。高清，细节丰富，电影质感；人物面部稳定不变形、动作连贯自然，无穿模无卡顿；保持无字幕，禁止显示任何文字或字幕；不要生成水印，不要生成店铺 Logo。',
    );

    expect(result.errors).toEqual([]);
  });

  it('rejects visual text instructions even when the prompt says no subtitles', () => {
    const result = validator.validate(
      '保持无字幕，避免生成任何文字或字幕。镜头1：主体举着写有“限时特惠”的红色手牌。高清电影质感，画面稳定无变形，不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toContainEqual(expect.stringContaining('画面文字'));
  });

  it('rejects colored-text banners even when the prompt says no subtitles', () => {
    const result = validator.validate(
      '保持无字幕，避免生成任何文字或字幕。镜头1：背景悬挂蓝底白字横幅。高清电影质感，画面稳定无变形，不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toContainEqual(expect.stringContaining('画面文字'));
  });

  it('warns when a multi-subject prompt lacks duplicate-character constraints', () => {
    const result = validator.validate(
      '<主体1> 与 <主体2> 在餐桌旁交谈。高清电影质感，画面稳定无变形，保持无字幕，避免生成任何文字或字幕，不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toContainEqual(expect.stringContaining('双胞胎'));
  });

  it('auto-fills the mandatory fallback packages during normalization', () => {
    const result = validator.normalize(
      '参考 @图片1 中的<主体1>，生成她坐在窗边吃蛋糕的画面。',
    );

    expect(result.changes).toEqual(
      expect.arrayContaining([
        '已补齐画质包',
        '已补齐稳定包',
        '已补齐水印/Logo 兜底',
      ]),
    );
    expect(result.prompt).toContain('高清，细节丰富，电影质感');
    expect(result.prompt).toContain('动作连贯自然');
    expect(result.prompt).toContain('不要生成水印；不要生成 Logo');
    expect(validator.validate(result.prompt).errors).toEqual([]);
  });

  it('auto-fills duplicate-character constraints for multi-subject prompts', () => {
    const result = validator.normalize(
      '<主体1> 与 <主体2> 在餐桌旁交谈。高清电影质感，画面稳定无变形，保持无字幕，避免生成任何文字或字幕，不要生成水印，不要生成 Logo。',
    );

    expect(result.changes).toContain('已补齐双胞胎兜底');
    expect(result.prompt).toContain('双胞胎效果');
  });

  it('does not duplicate fallback packages that are already present', () => {
    const result = validator.normalize(
      '参考 @图片1 中的<主体1>，生成她坐在窗边吃蛋糕的画面。高清，细节丰富，电影质感；人物面部稳定不变形、动作连贯自然，无穿模无卡顿；保持无字幕，避免生成任何文字或字幕；不要生成水印，不要生成 Logo。',
    );

    expect(result.changes).toEqual([]);
  });

  it('rejects asset references that exceed the official count limits', () => {
    const tooManyImages = validator.validate(
      '参考 @图片1 与 @图片10 中的<主体1>，生成画面。高清电影质感，画面稳定无变形，保持无字幕，避免生成任何文字或字幕，不要生成水印，不要生成 Logo。',
    );
    const tooManyVideos = validator.validate(
      '参考 @视频4 的运镜，生成画面。高清电影质感，画面稳定无变形，保持无字幕，避免生成任何文字或字幕，不要生成水印，不要生成 Logo。',
    );

    expect(tooManyImages.errors).toContainEqual(
      expect.stringContaining('引用了不存在的素材编号'),
    );
    expect(tooManyVideos.errors).toContainEqual(
      expect.stringContaining('引用了不存在的素材编号'),
    );
  });

  it('accepts asset references within the official count limits', () => {
    const result = validator.validate(
      '参考 @图片1、@图片2、@视频3 与 @音频3，生成画面。高清电影质感，画面稳定无变形，保持无字幕，避免生成任何文字或字幕，不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toEqual([]);
  });

  it('rejects audio-only prompts', () => {
    const result = validator.validate(
      '配合 @音频1 的节奏，生成画面。高清电影质感，画面稳定无变形，保持无字幕，避免生成任何文字或字幕，不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toContainEqual(
      expect.stringContaining('不支持「纯音频」与「文本 + 音频」输入'),
    );
  });

  it('rejects dialogue written with quotes instead of braces', () => {
    const result = validator.validate(
      '镜头1：近景，<主体1> 低头笑着说“骗你们的”，舍友追着打闹。高清电影质感，画面稳定无变形，保持无字幕，避免生成任何文字或字幕，不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toContainEqual(expect.stringContaining('台词必须使用'));
  });

  it('accepts dialogue wrapped in braces', () => {
    const result = validator.validate(
      '镜头1：近景，<主体1> 低头笑着说 {骗你们的}，舍友追着打闹。高清电影质感，画面稳定无变形，保持无字幕，避免生成任何文字或字幕，不要生成水印，不要生成 Logo。',
    );

    expect(result.errors).toEqual([]);
  });
});
