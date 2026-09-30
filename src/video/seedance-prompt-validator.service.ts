import { Injectable } from '@nestjs/common';
import {
  ASSET_REF_LIMITS,
  MUST_CONTAIN_RULES,
  PROHIBITION_RULES,
} from './seedance-rules';

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
      const normalizeChange = PROHIBITION_RULES.absoluteShotTime.normalizeChange;
      if (withoutAbsoluteTimes !== normalized && normalizeChange) {
        normalized = withoutAbsoluteTimes;
        changes.push(normalizeChange);
      }
    }

    // sd2-pe「强制兜底」默认必挂：缺失即自动补齐并透明披露
    const missingRules = this.findMissingMustContainRules(normalized);
    if (missingRules.length > 0) {
      normalized = `${normalized.trim()}\n\n${missingRules
        .map((rule) => rule.appendText)
        .join('；')}。`;
      changes.push(...missingRules.map((rule) => rule.normalizeMessage));
    }

    return { prompt: normalized, changes };
  }

  validate(prompt: string): SeedancePromptValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const normalized = this.normalizeLineEndings(prompt);

    if (/\[?asset-[\w-]+\]?/i.test(normalized)) {
      errors.push(PROHIBITION_RULES.rawAssetId.message);
    }

    const assetRefs = this.countAssetReferences(normalized);
    if (
      assetRefs.image > ASSET_REF_LIMITS.image ||
      assetRefs.video > ASSET_REF_LIMITS.video ||
      assetRefs.audio > ASSET_REF_LIMITS.audio
    ) {
      errors.push(PROHIBITION_RULES.assetReferenceLimit.message);
    } else if (
      assetRefs.audio > 0 &&
      assetRefs.image === 0 &&
      assetRefs.video === 0
    ) {
      errors.push(PROHIBITION_RULES.audioOnlyInput.message);
    }

    if (/@(?:图片|视频|音频)\d+(?=(?:跑|走|站|坐|拿|向|往|在|位于|左|右|前|后))/.test(normalized)) {
      errors.push(PROHIBITION_RULES.ambiguousAssetReference.message);
    }

    if (/(?:严格编辑|向前延长|向后延长|延长)[\s\S]*?参考\s*@视频\d+|参考\s*@视频\d+[\s\S]*?(?:严格编辑|向前延长|向后延长|延长)/.test(normalized)) {
      errors.push(PROHIBITION_RULES.editReference.message);
    }

    const shotBlocks = normalized.match(/镜头\s*\d+[\s\S]*?(?=镜头\s*\d+|$)/g) ?? [];
    for (const shot of shotBlocks) {
      const cameraMoves = new Set(
        [...shot.matchAll(/推镜头|拉镜头|摇镜头|移镜头|跟拍|固定机位|固定镜头|平移|(?<![\p{L}])推|(?<![\p{L}])拉|(?<![\p{L}])摇/gu)]
          .map((match) => match[0].replace(/镜头|机位/g, '')),
      );
      if (cameraMoves.size > 1) {
        errors.push(PROHIBITION_RULES.conflictingCameraMove.message);
        break;
      }
    }

    const absoluteTimePattern = /(?:\d{1,2}:\d{2}(?::\d{2})?\s*[-~–—至到]\s*\d{1,2}:\d{2}(?::\d{2})?|\d+\s*(?:秒|s)|\d+\s*[-~–—至到]\s*\d+\s*(?:秒|s))/i;
    if (shotBlocks.length >= 2 && absoluteTimePattern.test(normalized)) {
      errors.push(PROHIBITION_RULES.absoluteShotTime.message);
    }

    if (this.hasVisualTextInstruction(normalized)) {
      errors.push(PROHIBITION_RULES.visualTextInstruction.message);
    }

    if (this.hasUnwrappedDialogue(normalized)) {
      errors.push(PROHIBITION_RULES.unwrappedDialogue.message);
    }

    for (const rule of this.findMissingMustContainRules(normalized)) {
      if (rule.severity === 'error') {
        errors.push(rule.validateMessage);
      } else {
        warnings.push(rule.validateMessage);
      }
    }

    return { errors, warnings };
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

  /** 按当前场景筛出缺失的必挂规则（多主体规则仅在 `<主体N>` 数量 > 1 时生效）。 */
  private findMissingMustContainRules(prompt: string) {
    const subjectCount = this.countSubjects(prompt);
    return MUST_CONTAIN_RULES.filter(
      (rule) =>
        (!rule.multiSubjectOnly || subjectCount > 1) && !rule.present.test(prompt),
    );
  }

  /** 统计提示词引用到的素材最大序号（@图片N / @视频N / @音频N），用于校验官方数量上限 */
  private countAssetReferences(prompt: string): {
    image: number;
    video: number;
    audio: number;
  } {
    const maxIndex = (kind: string) =>
      Math.max(
        0,
        ...[...prompt.matchAll(new RegExp(`@${kind}(\\d+)`, 'g'))].map((match) =>
          Number(match[1]),
        ),
      );

    return {
      image: maxIndex('图片'),
      video: maxIndex('视频'),
      audio: maxIndex('音频'),
    };
  }

  private countSubjects(prompt: string): number {
    return new Set(
      [...prompt.matchAll(/<主体(\d+)>/g)].map((match) => match[1]),
    ).size;
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