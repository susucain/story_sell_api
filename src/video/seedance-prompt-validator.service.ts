import { Injectable } from '@nestjs/common';

export interface SeedancePromptValidationResult {
  errors: string[];
  warnings: string[];
}

export interface SeedancePromptNormalizationResult {
  prompt: string;
  changes: string[];
}

@Injectable()
export class SeedancePromptValidatorService {
  normalize(
    prompt: string,
    options: { assetIdReplacements?: Record<string, string> } = {},
  ): SeedancePromptNormalizationResult {
    let normalized = this.normalizeLineEndings(prompt);
    const changes: string[] = [];

    for (const [assetId, reference] of Object.entries(
      options.assetIdReplacements ?? {},
    )) {
      if (!assetId || !reference) continue;
      const pattern = new RegExp(
        `\\[?${this.escapeRegExp(assetId)}\\]?`,
        'gi',
      );
      const replaced = normalized.replace(pattern, reference);
      if (replaced !== normalized) {
        normalized = replaced;
        changes.push(`已将素材 ${assetId} 替换为 ${reference}`);
      }
    }

    const shotBlocks = normalized.match(/镜头\s*\d+[\s\S]*?(?=镜头\s*\d+|$)/g) ?? [];
    if (shotBlocks.length >= 2) {
      const withoutAbsoluteTimes = this.removeMultiShotAbsoluteTimes(normalized);
      if (withoutAbsoluteTimes !== normalized) {
        normalized = withoutAbsoluteTimes;
        changes.push('已删除多镜头绝对时间码');
      }
    }

    if (!this.hasNoTextConstraint(normalized)) {
      normalized = `${normalized.trim()}\n\n保持无字幕，避免生成任何文字或字幕。`;
      changes.push('已补齐无文字画面约束');
    }

    const missingMandatoryPackages = this.findMissingMandatoryPackages(normalized);
    if (missingMandatoryPackages.length > 0) {
      normalized = `${normalized.trim()}\n\n${missingMandatoryPackages
        .map((pack) => pack.text)
        .join('；')}。`;
      changes.push(...missingMandatoryPackages.map((pack) => pack.change));
    }

    return { prompt: normalized, changes };
  }

  validate(prompt: string): SeedancePromptValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const normalized = this.normalizeLineEndings(prompt);

    if (/\[?asset-[\w-]+\]?/i.test(normalized)) {
      errors.push('Seedance 提示词不能直接使用 asset ID，请改用 @图片N、@视频N 或 @音频N 引用素材。');
    }

    if (/@(?:图片|视频|音频)\d+(?=(?:跑|走|站|坐|拿|向|往|在|位于|左|右|前|后))/.test(normalized)) {
      errors.push('素材引用后紧接动作或方位会产生歧义，请使用 <主体N>@图片N 或在引用后补充名词。');
    }

    if (/(?:严格编辑|向前延长|向后延长|延长)[\s\S]*?参考\s*@视频\d+|参考\s*@视频\d+[\s\S]*?(?:严格编辑|向前延长|向后延长|延长)/.test(normalized)) {
      errors.push('视频编辑或延长任务不能写“参考 @视频N”，请直接使用“严格编辑 @视频N”或“向前/向后延长 @视频N”。');
    }

    const shotBlocks = normalized.match(/镜头\s*\d+[\s\S]*?(?=镜头\s*\d+|$)/g) ?? [];
    for (const shot of shotBlocks) {
      const cameraMoves = new Set(
        [...shot.matchAll(/推镜头|拉镜头|摇镜头|移镜头|跟拍|固定机位|固定镜头|平移|(?<![\p{L}])推|(?<![\p{L}])拉|(?<![\p{L}])摇/gu)]
          .map((match) => match[0].replace(/镜头|机位/g, '')),
      );
      if (cameraMoves.size > 1) {
        errors.push('同一镜头只能指定一种运镜方式，请拆分或保留一个运镜。');
        break;
      }
    }

    const absoluteTimePattern = /(?:\d{1,2}:\d{2}(?::\d{2})?\s*[-~–—至到]\s*\d{1,2}:\d{2}(?::\d{2})?|\d+\s*(?:秒|s)|\d+\s*[-~–—至到]\s*\d+\s*(?:秒|s))/i;
    if (shotBlocks.length >= 2 && absoluteTimePattern.test(normalized)) {
      errors.push(
        '多镜头 Seedance 提示词请使用镜头顺序，不要写绝对秒数或时间码。删除如“0-3秒”“0:00-0:03”的标记，仅保留“镜头1 / 镜头2 / 镜头3”。',
      );
    }

    if (!this.hasNoTextConstraint(normalized)) {
      errors.push('Seedance 提示词必须包含“保持无字幕，避免生成任何文字或字幕”约束。');
    }

    if (this.hasVisualTextInstruction(normalized)) {
      errors.push('Seedance 提示词不能要求生成画面文字、字幕、标题、标语、手牌文字或按钮，所有文字请在后期添加。');
    }

    if (this.hasUnwrappedDialogue(normalized)) {
      errors.push('台词必须使用 {…} 包裹（如 {你好，世界}），不要用引号直述。');
    }

    if (!/(?:高清|画质|电影质感|细节丰富)/.test(normalized)) {
      warnings.push('建议补充画质约束，例如“高清，细节丰富，电影质感”。');
    }
    if (!/(?:稳定不变形|动作连贯|无穿模|无卡顿|画面稳定)/.test(normalized)) {
      warnings.push('建议补充人物与动作稳定性约束。');
    }
    if (!/(?:不要生成水印|无水印).*(?:不要生成\s*Logo|无\s*Logo)|(?:不要生成\s*Logo|无\s*Logo).*(?:不要生成水印|无水印)/i.test(normalized)) {
      warnings.push('建议补充“不要生成水印；不要生成 Logo”约束。');
    }

    if (this.countSubjects(normalized) > 1 && !/(?:双胞胎|分身|人物重复|重复复刻)/.test(normalized)) {
      warnings.push('多人场景建议补充禁止人物重复或双胞胎效果的约束。');
    }

    return { errors, warnings };
  }

  /**
   * sd2-pe「强制兜底」中默认必挂的约束包；缺失时在 normalize 阶段自动补齐并披露，
   * 多人 / 多主体场景额外必挂双胞胎兜底，避免仅靠提示词提醒而被忽略。
   */
  private readonly mandatoryPackages: Array<{
    change: string;
    present: RegExp;
    text: string;
    multiSubjectOnly?: boolean;
  }> = [
    {
      change: '已补齐画质包',
      present: /(?:高清|画质|电影质感|细节丰富)/,
      text: '高清，细节丰富，电影质感，色彩自然，光影柔和',
    },
    {
      change: '已补齐稳定包',
      present: /(?:稳定不变形|动作连贯|无穿模|无卡顿|画面稳定|面部稳定)/,
      text: '人物面部稳定不变形、五官清晰、动作连贯自然，不僵硬，无穿模无卡顿',
    },
    {
      change: '已补齐水印/Logo 兜底',
      present:
        /(?:不要生成水印|无水印)[\s\S]*(?:不要生成\s*Logo|无\s*Logo)|(?:不要生成\s*Logo|无\s*Logo)[\s\S]*(?:不要生成水印|无水印)/i,
      text: '不要生成水印；不要生成 Logo',
    },
    {
      change: '已补齐双胞胎兜底',
      present: /(?:双胞胎|分身|人物重复|重复复刻)/,
      text: '视频全程禁止出现外形、着装、配饰完全一致的人物，禁止生成同款分身、双胞胎效果，同一画面中仅保留单个对应人物，不出现人物重复复刻',
      multiSubjectOnly: true,
    },
  ];

  private findMissingMandatoryPackages(prompt: string) {
    const subjectCount = this.countSubjects(prompt);
    return this.mandatoryPackages.filter(
      (pack) =>
        (!pack.multiSubjectOnly || subjectCount > 1) && !pack.present.test(prompt),
    );
  }

  private countSubjects(prompt: string): number {
    return new Set(
      [...prompt.matchAll(/<主体(\d+)>/g)].map((match) => match[1]),
    ).size;
  }

  private normalizeLineEndings(prompt: string): string {
    return prompt.replace(/\r\n/g, '\n');
  }

  private escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private removeMultiShotAbsoluteTimes(prompt: string): string {
    const timestampRange =
      /\d{1,2}:\d{2}(?::\d{2})?\s*[-~–—至到]\s*\d{1,2}:\d{2}(?::\d{2})?/gi;
    const secondRange = /\d+(?:\.\d+)?\s*(?:秒|s)\s*[-~–—至到]\s*\d+(?:\.\d+)?\s*(?:秒|s)?/gi;
    const compactSecondRange = /\d+(?:\.\d+)?\s*[-~–—至到]\s*\d+(?:\.\d+)?\s*(?:秒|s)/gi;
    const standaloneSeconds = /\d+(?:\.\d+)?\s*(?:秒|s)\b/gi;

    return prompt
      .replace(timestampRange, '')
      .replace(secondRange, '')
      .replace(compactSecondRange, '')
      .replace(standaloneSeconds, '')
      .replace(/[：:]\s*([，,、])/g, '$1')
      .replace(/[（(]\s*[）)]/g, '');
  }

  private hasNoTextConstraint(prompt: string): boolean {
    return /(?:保持|全程|画面)?\s*(?:无字幕|不含字幕|禁止字幕)[，,；;、\s]*(?:避免|禁止|不得)\s*(?:生成|出现|显示)?\s*(?:任何)?\s*(?:文字|字幕)/.test(prompt);
  }

  /** sd2-pe 特殊字符规范：台词必须用 {} 包裹，禁止用引号直述。 */
  private hasUnwrappedDialogue(prompt: string): boolean {
    const speechVerbs =
      '说道|说出|说|讲到|问道|问|答道|回答|喊道|喊|低语|嘟囔|念道|唱道|介绍道|嘱咐道|笑道|补充道|回应|自言自语';
    return new RegExp(
      `(?:${speechVerbs})[：:]?\\s*[“"「『][^”"」』\\n]{1,80}[”"」』]`,
    ).test(prompt);
  }

  private hasVisualTextInstruction(prompt: string): boolean {
    const visualTextPatterns = [
      /(?:生成|添加|叠加|手持|举着|写有|写着|悬浮|展示|弹出|出现|预留)[^。；\n]{0,40}(?:字幕|文字|文案|标题|标语|字样|书法字|汉字|按钮|倒计时|文字图层|字幕条|手牌|横幅|竖幅|Logo)/gi,
      /(?:蓝底白字|白底黑字|红底白字|黄底黑字|文字图层|特效字幕|字幕条|书法字|店铺\s*Logo)/gi,
    ];

    return visualTextPatterns.some((pattern) =>
      [...prompt.matchAll(pattern)].some((match) => !this.isNegated(prompt, match.index ?? 0)),
    );
  }

  private isNegated(prompt: string, index: number): boolean {
    return /(?:不|无|禁止|避免|不得|不要)\s*(?:生成|添加|叠加|手持|举着|写有|写着|悬浮|展示|弹出|出现|预留|显示)?\s*$/.test(
      prompt.slice(Math.max(0, index - 12), index),
    );
  }
}
