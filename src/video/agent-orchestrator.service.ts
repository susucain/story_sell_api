import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isStepCount, tool, ToolLoopAgent, zodSchema } from 'ai';
import { z } from 'zod/v4';
import {
  AgentRoleRegistryService,
  RoleId,
  RoleProfile,
} from './agent-role.registry';
import {
  DEFAULT_VERTICAL_ID,
  getVerticalProfile,
  VerticalProfile,
} from './vertical-profile.registry';
import { VideoLLMService } from './video-llm.service';
import { VideoToolsService } from './video-tools.service';
import {
  VideoAgentExecutionService,
  VideoAgentMutationState,
} from './video-agent-execution.service';

/** 创作简报：导演角色沉淀下来的结构化输入，供子 Agent 复用。 */
export interface CreativeBrief {
  vertical: string;
  goal: string;
  [key: string]: unknown;
}

export interface RoleAgentOutput {
  role: RoleId;
  output: string;
}

export interface OrchestratorToolContext {
  requestId?: string;
  sessionId: string;
  userId: number;
  currentMessageId?: number;
  parentSignal?: AbortSignal;
  mutationState?: VideoAgentMutationState;
  /** 当前会话垂类，透传给子 Agent 的工具与解析策略 */
  vertical?: string;
  /** 每次成功分派一个角色后回调，供调用方记录分派状态（如落库前置校验、过程面板） */
  onRoleDispatched?: (role: RoleId) => void;
}

export interface OrchestratorRunRequest {
  brief: CreativeBrief;
  dispatch: RoleId[];
  /** 整轮编排的总预算，缺省使用 VideoAgentExecutionService.totalTimeoutMs。 */
  deadlineMs?: number;
  context?: OrchestratorToolContext;
}

export interface OrchestratorRunResult {
  /** 实际执行的子 Agent 顺序。 */
  order: RoleId[];
  brief: CreativeBrief;
  outputs: RoleAgentOutput[];
}

@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);

  constructor(
    private readonly roleRegistry: AgentRoleRegistryService,
    private readonly llmService: VideoLLMService,
    private readonly toolsService: VideoToolsService,
    private readonly executionService: VideoAgentExecutionService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 多 Agent 编排开关，默认开启。
   * VIDEO_AGENT_ORCHESTRATION=0/false/off/disabled 时回退到单 Agent 路径。
   */
  isEnabled(): boolean {
    const raw = this.config.get<string>('VIDEO_AGENT_ORCHESTRATION');
    if (!raw) return true;
    return !['0', 'false', 'off', 'disabled'].includes(
      raw.trim().toLowerCase(),
    );
  }

  /**
   * 按导演给出的顺序依次执行子 Agent，并在整轮总预算内收窄每个角色的预算。
   * 超时统一映射为 VideoAgentTimeoutError（code=MODEL_TIMEOUT），保持可重试语义。
   */
  async run(request: OrchestratorRunRequest): Promise<OrchestratorRunResult> {
    const { brief, dispatch } = request;
    const context: OrchestratorToolContext = request.context ?? {
      sessionId: 'orchestrator',
      userId: 0,
    };
    const totalBudgetMs =
      request.deadlineMs ?? this.executionService.totalTimeoutMs;
    const startedAt = Date.now();
    const outputs: RoleAgentOutput[] = [];

    for (const roleId of dispatch) {
      const remainingMs = totalBudgetMs - (Date.now() - startedAt);
      const role = this.roleRegistry.getRoleProfile(roleId);
      const output = await this.runRoleAgent(role, brief, context, {
        timeoutMs: Math.min(remainingMs, this.executionService.roleAgentTimeoutMs),
        mutationState: context.mutationState,
      });
      outputs.push({ role: roleId, output });
    }

    return { order: [...dispatch], brief, outputs };
  }

  /** 生成挂载到导演 Agent 上的编排工具：提交简报 + 分派角色子 Agent。 */
  buildDispatchTools(context: OrchestratorToolContext) {
    const briefRef: { current?: CreativeBrief } = {};
    return {
      submit_creative_brief: tool({
        description:
          '提交本轮的结构化创作简报（垂类、目标、受众、时长等），供后续分派角色子 Agent 复用。',
        inputSchema: zodSchema(
          z.object({
            vertical: z.string().describe('垂类标识，例如 life-service'),
            goal: z.string().describe('本轮创作目标'),
            details: z
              .record(z.string(), z.unknown())
              .optional()
              .describe('其余简报字段'),
          }),
        ),
        execute: async (input: {
          vertical: string;
          goal: string;
          details?: Record<string, unknown>;
        }) => {
          const brief: CreativeBrief = {
            ...(input.details ?? {}),
            vertical: input.vertical,
            goal: input.goal,
          };
          briefRef.current = brief;
          return { brief };
        },
      }),
      dispatch_role_agent: tool({
        description:
          '把一项专业任务分派给指定角色子 Agent（编剧 screenwriter / 分镜导演 shot-planner / 摄影 cinematographer / 质检 reviewer），返回该角色的产出。创作或修改脚本时必须先按 编剧 → 分镜导演 → 摄影 的顺序分派，再汇总产出保存脚本。',
        inputSchema: zodSchema(
          z.object({
            role: z.enum([
              'screenwriter',
              'shot-planner',
              'cinematographer',
              'reviewer',
            ]),
            task: z.string().describe('交给该角色的具体任务描述'),
          }),
        ),
        execute: async (input: { role: RoleId; task: string }) => {
          const brief: CreativeBrief = briefRef.current ?? {
            vertical: DEFAULT_VERTICAL_ID,
            goal: input.task,
          };
          const { outputs } = await this.run({
            brief: { ...brief, task: input.task },
            dispatch: [input.role],
            context,
          });
          context.onRoleDispatched?.(input.role);
          return { role: input.role, output: outputs[0]?.output ?? '' };
        },
      }),
    };
  }

  private runRoleAgent(
    role: RoleProfile,
    brief: CreativeBrief,
    context: OrchestratorToolContext,
    deadline: { timeoutMs: number; mutationState?: VideoAgentMutationState },
  ): Promise<string> {
    return this.executionService.runRoleAgent(
      {
        requestId: context.requestId,
        sessionId: context.sessionId,
        toolName: `dispatch_role_agent:${role.id}`,
        parentSignal: context.parentSignal,
        mutationState: context.mutationState,
        timeoutMs: deadline.timeoutMs,
      },
      async (signal) => {
        const agent = new ToolLoopAgent({
          instructions: this.buildRolePrompt(role),
          model: this.llmService.getLanguageModel(),
          tools: this.toolsService.buildTools(
            {
              requestId: context.requestId,
              sessionId: context.sessionId,
              userId: context.userId,
              currentMessageId: context.currentMessageId,
              parentSignal: signal,
              mutationState: context.mutationState,
              vertical: context.vertical ?? brief.vertical,
            },
            role,
          ),
          stopWhen: isStepCount(12),
        });

        this.logger.log(
          JSON.stringify({
            requestId: context.requestId,
            sessionId: context.sessionId,
            phase: 'role_agent',
            role: role.id,
          }),
        );

        const result = await agent.generate({
          prompt: this.buildRoleTask(role, brief),
          abortSignal: signal,
        });
        return result.text ?? '';
      },
    );
  }

  private buildRolePrompt(role: RoleProfile): string {
    const vertical = this.resolveVertical(role);
    return [
      role.identity,
      role.outputSchemaHint ? `输出要求：${role.outputSchemaHint}` : '',
      '## 指南路由',
      vertical.guideRouting,
    ]
      .filter((section) => section !== '')
      .join('\n\n');
  }

  private buildRoleTask(role: RoleProfile, brief: CreativeBrief): string {
    return [
      `你的角色：${role.displayName}（${role.id}）`,
      '以下是本轮创作简报，请据此完成你负责的部分：',
      JSON.stringify(brief, null, 2),
    ].join('\n');
  }

  private resolveVertical(role: RoleProfile): VerticalProfile {
    return getVerticalProfile(role.vertical ?? DEFAULT_VERTICAL_ID);
  }
}