/**
 * 垂类 profile：承载与具体品类绑定的系统提示词文案。
 * 角色 profile（agent-role.registry）负责「谁来做」，垂类 profile 负责「面向哪个品类」。
 */
export interface VerticalProfile {
  id: string;
  displayName: string;
  /** 指南路由段落，逐行拼进系统提示词。 */
  guideRouting: string;
  /** 持久化约束段落，支持 {maxDurationSec} 与 {durationHint} 占位符。 */
  persistenceConstraints: string;
  /** 新建脚本时附带的时长/画幅建议，写入 {durationHint} 占位符。 */
  durationHint: string;
}

export const DEFAULT_VERTICAL_ID = 'life-service';

export const VERTICAL_PROFILES: Record<string, VerticalProfile> = {
  'life-service': {
    id: 'life-service',
    displayName: '生活服务',
    guideRouting: [
      '脚本创作或修改：先读取 `life-service-storyboard-generator/references/routing.md`、`life-service-storyboard-generator/references/storyboard.md` 和 `life-service-storyboard-generator/references/seedance.md`。',
      '涉及角色、系统虚拟人、上传人像或服装：在上述三份之外，再读取 `life-service-storyboard-generator/references/character.md`。',
      '仅查询视频状态、结果或失败原因，以及仅分析素材时：不要读取创作指南。仅优化或检查 Seedance 提示词时：读取 `life-service-storyboard-generator/references/seedance.md`。',
      '按需读取专项资料：按视频类型读取 `life-service-storyboard-generator/references/type-configuration-center.md` 的对应段落；按 Seedance 格式读取 `life-service-storyboard-generator/references/seedance_2_0_template.md`。每次调用 generate_script 保存 seedance_prompt 前，必须读取 `sd2-pe/SKILL.md` 完成审查。',
      '所有指南和专项资料均按需读取；不得将其完整内容自动注入系统提示词。',
    ].join('\n'),
    persistenceConstraints: [
      '每轮创作或修改脚本都必须先调用 start_script_creation（本会话之前调用过也要重新调用；未调用前不得读取创作指南或调用 generate_script）；普通问候、素材分析、商品画像更新、知识问答和已确认脚本的视频生成不得调用它。',
      '准备完成后必须调用 generate_script 保存 title、storyboard_markdown、seedance_prompt 和 meta；仅在保存成功后才可确认脚本已生成。用户确认已保存脚本后才可调用 create_video_task。',
      '视频模型单次生成上限为 {maxDurationSec} 秒，脚本总时长、最后一个镜头结束时间和提交的生成时长都不得超过 {maxDurationSec} 秒。',
      '{durationHint}',
      '修改已有脚本先调用 get_script；若内容已满足要求，调用 complete_without_script_change，不创建新版本。缺少必要时间范围、素材、角色选择或存在冲突时，调用 request_user_confirmation 后停止创作。',
      '查询已保存脚本或提示词先用 get_script，需要选择版本先用 list_scripts；查询视频任务先用 get_video_task_status；查询会话状态或上下文先用 get_session_state，不得猜测持久化数据。',
      '用户给出商品名称、卖点、受众、时长、平台或风格时，及时调用 update_creative_brief（life-service 字段映射：subject=商品名称、key_points=卖点、audience=受众）。除非用户明确要求查看已保存内容，不在对话中输出完整分镜或 Seedance 提示词。',
    ].join('\n'),
    durationHint:
      'generate_script 的 meta 建议填写 duration（视频总时长，秒，上限 {maxDurationSec} 秒）和 ratio（9:16、16:9 或 1:1），并与 storyboard_markdown 的总时长保持一致。',
  },
};

export function getVerticalProfile(id: string): VerticalProfile {
  if (!Object.hasOwn(VERTICAL_PROFILES, id)) {
    throw new Error(`未知 vertical profile：${id}`);
  }
  return VERTICAL_PROFILES[id];
}

/** 把任意来源的垂类取值收敛为已知垂类 id，未知时回退到默认垂类。 */
export function resolveVerticalId(value: unknown): string {
  return typeof value === 'string' && Object.hasOwn(VERTICAL_PROFILES, value)
    ? value
    : DEFAULT_VERTICAL_ID;
}