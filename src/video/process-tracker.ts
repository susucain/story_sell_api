import {
  ProcessAction,
  ProcessCard,
  ProcessItem,
  ProcessOutput,
  ProcessPhase,
  ProcessState,
  ProcessStateDataPart,
} from './types/process-state';
import { VideoAsset } from './entities/video-asset.entity';

const GUIDELINE_CARDS: ProcessCard[] = [
  {
    id: 'platform-compliance',
    icon: '🛡️',
    iconColor: '#ef4444',
    iconBg: 'rgba(239,68,68,0.1)',
    title: '平台合规要求',
    description: '规避低质营销与违规话术',
  },
  {
    id: 'shot-duration',
    icon: '⏱️',
    iconColor: '#f59e0b',
    iconBg: 'rgba(245,158,11,0.1)',
    title: '分镜时长规范',
    description: '每镜头 2-8 秒节奏控制',
  },
  {
    id: 'story-structure',
    icon: '📖',
    iconColor: '#10b981',
    iconBg: 'rgba(16,185,129,0.1)',
    title: '故事结构模板',
    description: '钩子-卖点-证明-转化框架',
  },
  {
    id: 'video-template',
    icon: '🎬',
    iconColor: '#6366f1',
    iconBg: 'rgba(99,102,241,0.1)',
    title: '视频生成模板',
    description: '适配 Seedance 2.0 格式',
  },
  {
    id: 'narrative-mode',
    icon: '💡',
    iconColor: '#ec4899',
    iconBg: 'rgba(236,72,153,0.1)',
    title: '种草叙事模式',
    description: '生活方式带货话术风格',
  },
  {
    id: 'category-config',
    icon: '⚙️',
    iconColor: '#3b82f6',
    iconBg: 'rgba(59,130,246,0.1)',
    title: '品类适配配置',
    description: '匹配当前商品类目参数',
  },
];

const GENERATION_TOOLS = new Set([
  'read_file',
  'write_file',
  'update_product_profile',
  'generate_script',
]);

export class ProcessTracker {
  private state: ProcessState;
  private writer: { write: (chunk: any) => void };
  private productProfile?: Record<string, any> | null;
  private started = false;
  private finished = false;
  private hasGenerationActivity = false;
  private now = () => Date.now();

  constructor(options: {
    writer: { write: (chunk: any) => void };
    analysisAssets: VideoAsset[];
    productProfile?: Record<string, any> | null;
    isModification?: boolean;
  }) {
    this.writer = options.writer;
    this.productProfile = options.productProfile;
    const phases: ProcessPhase[] = [];
    const analysisAssets = options.analysisAssets ?? [];

    if (analysisAssets.length > 0) {
      phases.push({
        id: 'parse-materials',
        title: '解析素材',
        description: '识别商品主图、产品细节与参考视频内容',
        status: 'running',
        startTime: this.now(),
        items: analysisAssets.map((asset) => {
          const parsed = asset.parsedContent as { summary?: string } | undefined;
          const isParsed = asset.status === 'parsed';
          return {
            id: `asset-${asset.id}`,
            title: asset.name || `${asset.assetType === 'video' ? '视频' : '图片'}素材`,
            description: isParsed
              ? parsed?.summary ?? '已完成解析'
              : '等待解析',
            status: isParsed ? 'completed' : 'pending',
            tag: isParsed ? { text: '已解析', type: 'success' as const } : undefined,
          };
        }),
      });
    }

    phases.push({
      id: 'load-guidelines',
      title: '加载创作规范',
      description: '已加载 6 份创作规范，覆盖平台规则、分镜结构与视频模板',
      status: 'running',
      startTime: this.now(),
      cards: GUIDELINE_CARDS,
    });

    const duration = options.productProfile?.duration as number | undefined;
    const estimatedShots = duration ? Math.max(1, Math.ceil(duration / 5)) : undefined;

    phases.push({
      id: 'generate-script',
      title: options.isModification ? '修改并生成分镜脚本' : '提炼卖点并生成分镜脚本',
      description: '结合素材与规范，输出结构化分镜脚本',
      status: 'running',
      startTime: this.now(),
      actions: [
        {
          id: 'update-product-profile',
          title: '更新产品画像',
          description: '提炼核心卖点与视频参数',
          status: 'pending',
        },
        {
          id: 'generate-script-action',
          title: '生成分镜脚本',
          description: this.buildGenerateDesc(options.productProfile),
          status: 'pending',
        },
      ],
    });

    this.state = {
      status: 'running',
      startTime: this.now(),
      phases,
    };
  }

  private buildGenerateDesc(profile?: Record<string, any> | null): string {
    const parts: string[] = [];
    if (profile?.duration) parts.push(`预计 ${profile.duration} 秒`);
    // 画幅暂用固定 9:16，后续可从 profile 扩展
    parts.push('9:16 竖版');
    if (profile?.tone) parts.push(profile.tone);
    return parts.join(' · ') || '预计 30 秒 · 9:16 竖版';
  }

  /** 开始追踪，立即推送初始状态 */
  start() {
    if (this.started || this.finished) return;
    this.started = true;
    this.hasGenerationActivity = true;
    const startTime = this.now();
    this.state.status = 'running';
    this.state.startTime = startTime;
    this.state.phases.forEach((phase) => {
      if (phase.status === 'running') phase.startTime = startTime;
    });
    this.emit();
    // 阶段 2 在 Skill 加载完成后即完成
    this.markPhaseDone('load-guidelines');
    const materialPhase = this.state.phases.find((phase) => phase.id === 'parse-materials');
    if (materialPhase?.items?.every((item) => item.status === 'completed' || item.status === 'error')) {
      this.markPhaseDone('parse-materials');
    }
  }

  /** 记录非状态变更的创作流程活动（如 read_file / write_file） */
  recordActivity() {
    if (!this.started || this.finished) return;
    this.hasGenerationActivity = true;
  }

  /** 标记某个素材正在解析中 */
  markAssetRunning(assetId: number) {
    if (this.finished) return;
    this.hasGenerationActivity = true;
    const phase = this.state.phases.find((p) => p.id === 'parse-materials');
    if (!phase?.items) return;
    const item = phase.items.find((i) => i.id === `asset-${assetId}`);
    if (item) item.status = 'running';
    this.emit();
  }

  /** 标记素材解析完成 */
  markAssetParsed(assetId: number, summary: string) {
    if (this.finished) return;
    this.hasGenerationActivity = true;
    const phase = this.state.phases.find((p) => p.id === 'parse-materials');
    if (!phase?.items) return;
    const item = phase.items.find((i) => i.id === `asset-${assetId}`);
    if (item) {
      item.status = 'completed';
      item.description = summary;
      item.tag = { text: '已解析', type: 'success' };
    }
    if (phase.items.every((i) => i.status === 'completed' || i.status === 'error')) {
      this.markPhaseDone('parse-materials');
    } else {
      this.emit();
    }
  }

  /** 标记素材解析失败，后续请求可重试。 */
  markAssetFailed(assetId: number, _errorCode: string) {
    if (this.finished) return;
    this.hasGenerationActivity = true;
    const phase = this.state.phases.find((p) => p.id === 'parse-materials');
    if (!phase?.items) return;
    const item = phase.items.find((i) => i.id === `asset-${assetId}`);
    if (item) {
      item.status = 'error';
      item.description = '素材解析失败，可在后续请求中重试';
      item.tag = { text: '可重试', type: 'info' };
    }
    if (phase.items.every((i) => i.status === 'completed' || i.status === 'error')) {
      this.markPhaseDone('parse-materials');
    } else {
      this.emit();
    }
  }

  /** 标记产品画像正在更新 */
  markProfileRunning() {
    if (!this.started || this.finished) return;
    this.hasGenerationActivity = true;
    const phase = this.state.phases.find((p) => p.id === 'generate-script');
    if (!phase?.actions) return;
    const action = phase.actions.find((a) => a.id === 'update-product-profile');
    if (action) action.status = 'running';
    this.emit();
  }

  /** 标记产品画像更新完成 */
  markProfileUpdated(profile?: Record<string, any>) {
    if (!this.started || this.finished) return;
    this.hasGenerationActivity = true;
    if (profile) {
      this.productProfile = { ...(this.productProfile || {}), ...profile };
    }
    const phase = this.state.phases.find((p) => p.id === 'generate-script');
    if (!phase?.actions) return;
    const action = phase.actions.find((a) => a.id === 'update-product-profile');
    if (action) {
      action.status = 'completed';
      const sellingPoints = this.productProfile?.selling_points as string[] | undefined;
      if (sellingPoints && sellingPoints.length > 0) {
        action.description = `提炼 ${sellingPoints.length} 个核心卖点：${sellingPoints.slice(0, 3).join('、')}`;
      }
      // 根据更新后的画像刷新生成动作的描述
      const genAction = phase.actions.find((a) => a.id === 'generate-script-action');
      if (genAction) {
        genAction.description = this.buildGenerateDesc(this.productProfile);
      }
    }
    this.emit();
  }

  /** 标记正在生成分镜脚本 */
  markGenerating() {
    if (!this.started || this.finished) return;
    this.hasGenerationActivity = true;
    const phase = this.state.phases.find((p) => p.id === 'generate-script');
    if (!phase?.actions) return;
    const action = phase.actions.find((a) => a.id === 'generate-script-action');
    if (action) action.status = 'running';
    this.emit();
  }

  /** 提示词校验失败后，保留生成过程以等待 Agent 自动修正并重试。 */
  markScriptValidationFailed() {
    if (!this.started || this.finished) return;
    this.hasGenerationActivity = true;
    const phase = this.state.phases.find((p) => p.id === 'generate-script');
    const action = phase?.actions?.find((item) => item.id === 'generate-script-action');
    if (!action) return;
    action.status = 'running';
    action.title = '修正 Seedance 2.0 提示词';
    action.description = '提示词校验未通过，正在自动修正并重新保存脚本';
    this.emit();
  }

  /** 标记分镜脚本生成完成 */
  markScriptGenerated(result: {
    title: string;
    shot_count: number;
    version: number;
  }) {
    if (!this.started || this.finished) return;
    this.hasGenerationActivity = true;
    const phase = this.state.phases.find((p) => p.id === 'generate-script');
    if (!phase) return;
    if (phase.actions) {
      const action = phase.actions.find((a) => a.id === 'generate-script-action');
      if (action) {
        action.status = 'completed';
        action.title = `生成 ${result.shot_count} 镜头分镜脚本`;
      }
    }

    const platform = this.productProfile?.platform as string | undefined;
    const tags: string[] = [
      result.title,
      `${result.shot_count} 个镜头`,
      `V${result.version}`,
      platform,
    ].filter((t): t is string => typeof t === 'string' && t.length > 0);

    phase.outputs = [
      {
        title: `${result.title} 预期产出`,
        tags,
      },
    ];
    this.markPhaseDone('generate-script');
  }

  /** 当前脚本已满足用户要求，无需创建重复版本。 */
  markScriptUnchanged(description: string) {
    if (!this.started || this.finished) return;
    this.hasGenerationActivity = true;
    const phase = this.state.phases.find((item) => item.id === 'generate-script');
    if (!phase) return;
    const action = phase.actions?.find((item) => item.id === 'generate-script-action');
    if (action) {
      action.status = 'completed';
      action.title = '无需生成新版本';
      action.description = description;
    }
    this.markPhaseDone('generate-script');
  }

  /** 本轮已完成分析，等待用户补充或确认后再开启下一轮。 */
  waitForUser(input: {
    title?: string;
    description: string;
  }) {
    if (!this.started || this.finished) return;
    this.finished = true;
    const endTime = this.now();
    const phase = this.state.phases.find((item) => item.id === 'generate-script');
    if (phase) {
      phase.status = 'waiting_for_user';
      phase.endTime = endTime;
      const action = phase.actions?.find((item) => item.id === 'generate-script-action');
      if (action) {
        action.status = 'waiting_for_user';
        action.title = input.title || '等待用户确认';
        action.description = input.description;
      }
    }
    this.state.status = 'waiting_for_user';
    this.state.endTime = endTime;
    this.emit();
  }

  /** 流正常结束 */
  finish() {
    if (!this.started || this.finished) return;
    this.finished = true;
    if (!this.hasGenerationActivity) {
      this.state.status = 'skipped';
      this.state.endTime = this.now();
      this.emit();
      return;
    }
    // 将仍处于 running 的阶段标记为完成
    this.state.phases.forEach((phase) => {
      if (phase.status === 'running') {
        phase.status = 'completed';
        phase.endTime = this.now();
      }
      phase.items?.forEach((item) => {
        if (item.status === 'running') item.status = 'completed';
      });
      phase.actions?.forEach((action) => {
        if (action.status === 'running') action.status = 'completed';
      });
    });
    this.state.status = 'completed';
    this.state.endTime = this.now();
    this.emit();
  }

  /** 流异常结束 */
  error(message?: string) {
    if (!this.started || this.finished) return;
    this.finished = true;
    this.state.status = 'error';
    this.state.endTime = this.now();
    this.state.phases.forEach((phase) => {
      if (phase.status === 'running') phase.status = 'error';
    });
    this.emit();
  }

  /** 判断某工具是否属于本次创作流程 */
  static isGenerationTool(toolName: string): boolean {
    return GENERATION_TOOLS.has(toolName);
  }

  private markPhaseDone(phaseId: ProcessPhase['id']) {
    const phase = this.state.phases.find((p) => p.id === phaseId);
    if (!phase || phase.status === 'completed') return;
    phase.status = 'completed';
    phase.endTime = this.now();
    this.emit();
  }

  private emit() {
    // 未 start() 前只更新内部状态、不推送，待 start_script_creation 开启面板时一次性渲染
    if (!this.started) return;
    const part: ProcessStateDataPart = {
      type: 'data-process-state',
      data: JSON.parse(JSON.stringify(this.state)),
    };
    this.writer.write(part);
  }
}
