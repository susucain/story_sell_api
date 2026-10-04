/**
 * sd2-pe 硬校验规则登记表。
 *
 * 作为「代码校验」与 `sd2-pe/SKILL.md`「强制约束」之间的单一事实来源：
 * - 必须包含类规则（must-contain）完全声明式，直接驱动校验与自动补齐；
 * - 禁止类规则（prohibition）的判定逻辑仍在 SeedancePromptValidatorService 中实现，
 *   但文案与条款映射统一取自本文件；
 * - SKILL_CLAUSE_COVERAGE 逐条登记 SKILL.md 的强制约束条款是否已被校验覆盖，
 *   由一致性测试核对，避免「文档写了、代码没校验」的漂移。
 */

/** 必须包含类规则：缺失时在 normalize 阶段自动补齐，并在 validate 阶段报错或警告。 */
export interface MustContainRule {
  id: string;
  /** validate 缺失时的级别 */
  severity: 'error' | 'warning';
  /** validate 缺失时的提示文案 */
  validateMessage: string;
  /** normalize 补齐时写入 changes 的披露文案 */
  normalizeMessage: string;
  /** 补齐时追加到提示词末尾的文本 */
  appendText: string;
  /** 存在性判定 */
  present: RegExp;
  /** 仅在多主体（`<主体N>` 数量 > 1）场景生效 */
  multiSubjectOnly?: boolean;
  /** 对应 SKILL.md 强制约束条款标题，供一致性测试核对 */
  skillClause: string;
}

export const MUST_CONTAIN_RULES: MustContainRule[] = [
  {
    id: 'noTextConstraint',
    severity: 'error',
    validateMessage:
      'Seedance 提示词必须包含“保持无字幕，避免生成任何文字或字幕”约束。',
    normalizeMessage: '已补齐无文字画面约束',
    appendText: '保持无字幕，避免生成任何文字或字幕',
    present:
      /(?:保持|全程|画面)?\s*(?:无字幕|不含字幕|禁止字幕)[，,；;、\s]*(?:避免|禁止|不得)\s*(?:生成|出现|显示)?\s*(?:任何)?\s*(?:文字|字幕)/,
    skillClause: '强制兜底',
  },
  {
    id: 'qualityPackage',
    severity: 'warning',
    validateMessage: '建议补充画质约束，例如“高清，细节丰富，电影质感”。',
    normalizeMessage: '已补齐画质包',
    appendText: '高清，细节丰富，电影质感，色彩自然，光影柔和',
    present: /(?:高清|画质|电影质感|细节丰富)/,
    skillClause: '强制兜底',
  },
  {
    id: 'stabilityPackage',
    severity: 'warning',
    validateMessage: '建议补充人物与动作稳定性约束。',
    normalizeMessage: '已补齐稳定包',
    appendText:
      '人物面部稳定不变形、五官清晰、动作连贯自然，不僵硬，无穿模无卡顿',
    present: /(?:稳定不变形|动作连贯|无穿模|无卡顿|画面稳定|面部稳定)/,
    skillClause: '强制兜底',
  },
  {
    id: 'watermarkLogoFallback',
    severity: 'warning',
    validateMessage: '建议补充“不要生成水印；不要生成 Logo”约束。',
    normalizeMessage: '已补齐水印/Logo 兜底',
    appendText: '不要生成水印；不要生成 Logo',
    present:
      /(?:不要生成水印|无水印)[\s\S]*(?:不要生成\s*Logo|无\s*Logo)|(?:不要生成\s*Logo|无\s*Logo)[\s\S]*(?:不要生成水印|无水印)/i,
    skillClause: '强制兜底',
  },
  {
    id: 'duplicateCharacterFallback',
    severity: 'warning',
    validateMessage: '多人场景建议补充禁止人物重复或双胞胎效果的约束。',
    normalizeMessage: '已补齐双胞胎兜底',
    appendText:
      '视频全程禁止出现外形、着装、配饰完全一致的人物，禁止生成同款分身、双胞胎效果，同一画面中仅保留单个对应人物，不出现人物重复复刻',
    present: /(?:双胞胎|分身|人物重复|重复复刻)/,
    multiSubjectOnly: true,
    skillClause: '强制兜底',
  },
];

/** 官方 API 参数与素材硬限制（Seedance 2.0 API 文档）。 */
export const ASSET_REF_LIMITS = { image: 9, video: 3, audio: 3 } as const;

/** 官方支持的最短生成时长（秒）。 */
export const MIN_VIDEO_DURATION_SEC = 4;

/** 禁止类规则：判定逻辑在 service 中实现，文案与条款映射登记于此。 */
export interface ProhibitionRule {
  id: string;
  /**
   * 命中级别：
   * - error（硬性规则）：会阻断保存并要求模型重写 —— API 限制、任务类型误判、无文字画面 / 特殊字符等强制约束；
   * - warning（软性规则）：仅打印告警，不阻断保存 —— 画面质量类建议，命中后由 normalize 或后续环节自行吸收。
   */
  severity: 'error' | 'warning';
  /** validate 命中时的报错文案 */
  message: string;
  /** normalize 阶段可自动修复时写入 changes 的披露文案 */
  normalizeChange?: string;
  /** 对应 SKILL.md 强制约束条款标题，供一致性测试核对 */
  skillClause: string;
}

export const PROHIBITION_RULES = {
  rawAssetId: {
    id: 'rawAssetId',
    severity: 'error',
    message:
      'Seedance 提示词不能直接使用 asset ID，请改用 @图片N、@视频N 或 @音频N 引用素材。',
    skillClause: 'Asset ID 屏蔽原则',
  },
  ambiguousAssetReference: {
    id: 'ambiguousAssetReference',
    severity: 'warning',
    message:
      '素材引用后紧接动作或方位会产生歧义，请使用 <主体N>@图片N 或在引用后补充名词。',
    skillClause: '断句防歧义原则',
  },
  editReference: {
    id: 'editReference',
    severity: 'error',
    message:
      '视频编辑或延长任务不能写“参考 @视频N”，请直接使用“严格编辑 @视频N”或“向前/向后延长 @视频N”。',
    skillClause: '任务类型优先 → 多模态参考再看复杂度',
  },
  conflictingCameraMove: {
    id: 'conflictingCameraMove',
    severity: 'warning',
    message: '同一镜头只能指定一种运镜方式，请拆分或保留一个运镜。',
    skillClause: '一镜一运镜',
  },
  absoluteShotTime: {
    id: 'absoluteShotTime',
    severity: 'warning',
    message:
      '多镜头 Seedance 提示词请使用镜头顺序，不要写绝对秒数或时间码。删除如“0-3秒”“0:00-0:03”的标记，仅保留“镜头1 / 镜头2 / 镜头3”。',
    normalizeChange: '已删除多镜头绝对时间码',
    skillClause: '镜头顺序优先于绝对时间',
  },
  visualTextInstruction: {
    id: 'visualTextInstruction',
    severity: 'error',
    message:
      'Seedance 提示词不能要求生成画面文字、字幕、标题、标语、手牌文字或按钮，所有文字请在后期添加。',
    skillClause: '无文字画面（最高优先级）',
  },
  unwrappedDialogue: {
    id: 'unwrappedDialogue',
    severity: 'error',
    message: '台词必须使用 {…} 包裹（如 {你好，世界}），不要用引号直述。',
    skillClause: '特殊字符规范（强制使用）',
  },
  assetReferenceLimit: {
    id: 'assetReferenceLimit',
    severity: 'error',
    message:
      'Seedance 提示词引用了不存在的素材编号（@图片N / @视频N / @音频N 超出当前可用素材范围），请改用实际存在的素材编号；若会话参考素材本身已超官方上限，请先请用户移除多余素材。',
    skillClause: '参数与素材规范',
  },
  audioOnlyInput: {
    id: 'audioOnlyInput',
    severity: 'error',
    message:
      'Seedance 2.0 不支持「纯音频」与「文本 + 音频」输入，提示词必须至少引用一张参考图片或一段参考视频。',
    skillClause: '参数与素材规范',
  },
  shortDuration: {
    id: 'shortDuration',
    severity: 'error',
    message: `脚本总时长不足官方最短生成时长 ${MIN_VIDEO_DURATION_SEC} 秒，请补足镜头内容后重新保存。`,
    skillClause: '参数与素材规范',
  },
} as const satisfies Record<string, ProhibitionRule>;

export type ProhibitionRuleId = keyof typeof PROHIBITION_RULES;

/** SKILL.md 强制约束条款的校验覆盖情况。 */
export interface SkillClauseCoverage {
  /** 与 SKILL.md 逐字一致的条款标题 */
  clause: string;
  /** 覆盖该条款的校验规则 id；为空表示该条款当前不可静态校验 */
  rules: string[];
  /** 不可静态校验的原因（说明为何只能作为提示词建议） */
  advisoryReason?: string;
}

export const SKILL_CLAUSE_COVERAGE: SkillClauseCoverage[] = [
  {
    clause: '无文字画面（最高优先级）',
    rules: ['visualTextInstruction', 'noTextConstraint'],
  },
  {
    clause: '特殊字符规范（强制使用）',
    rules: ['unwrappedDialogue'],
  },
  {
    clause: '任务类型优先 → 多模态参考再看复杂度',
    rules: ['editReference'],
    advisoryReason:
      '路径 A/B 的复杂度判定依赖语义理解，仅「编辑/延长不得写参考」可静态校验。',
  },
  {
    clause: '关键歧义不静默修改',
    rules: [],
    advisoryReason:
      '方位映射、运镜冲突、主体特征矛盾需通过交互向用户确认，无法在保存前静态判定。',
  },
  {
    clause: '强制兜底',
    rules: [
      'noTextConstraint',
      'qualityPackage',
      'stabilityPackage',
      'watermarkLogoFallback',
      'duplicateCharacterFallback',
    ],
  },
  {
    clause: 'Asset ID 屏蔽原则',
    rules: ['rawAssetId'],
  },
  {
    clause: '断句防歧义原则',
    rules: ['ambiguousAssetReference'],
  },
  {
    clause: '一镜一运镜',
    rules: ['conflictingCameraMove'],
  },
  {
    clause: '镜头顺序优先于绝对时间',
    rules: ['absoluteShotTime'],
  },
  {
    clause: '复杂多人正面动态场景',
    rules: [],
    advisoryReason:
      '强方位约束与固定机位属生成期画面判断，双胞胎兜底部分已归入「强制兜底」。',
  },
  {
    clause: '人脸参考最佳实践',
    rules: [],
    advisoryReason:
      '大头照 + 全身照、禁用多视图属素材组织建议，不体现在最终提示词文本上。',
  },
  {
    clause: '参数与素材规范',
    rules: ['assetReferenceLimit', 'audioOnlyInput', 'shortDuration'],
  },
];
