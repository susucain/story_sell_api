import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { VideoAsset } from './entities/video-asset.entity';
import { VideoScript } from './entities/video-script.entity';
import { VideoSession } from './entities/video-session.entity';
import { VideoTask } from './entities/video-task.entity';
import { StoryboardParserService } from './storyboard-parser.service';
import { VideoTaskService, MAX_VIDEO_DURATION_SEC } from './video-task.service';
import {
  getPresetAvatar,
  isLegacyAvatarAlias,
  isPresetAvatarId,
  validateAvatarOutfitSelection,
} from './avatar-catalog';
import { SeedancePromptValidatorService } from './seedance-prompt-validator.service';
import { MIN_VIDEO_DURATION_SEC, PROHIBITION_RULES } from './seedance-rules';
import { RoleProfile } from './agent-role.registry';
import {
  VideoAgentExecutionService,
  VideoAgentMutationState,
  VideoAgentTimeoutError,
} from './video-agent-execution.service';

interface ToolContext {
  requestId?: string;
  sessionId: string;
  userId: number;
  currentMessageId?: number;
  referencedVersion?: number;
  /** 当前会话垂类，决定分镜解析策略；缺省按 life-service 处理 */
  vertical?: string;
  /** 编排模式下要求 generate_script 之前必须已分派角色子 Agent */
  requireDispatch?: boolean;
  /** 已成功分派的角色列表，由编排工具回填 */
  dispatchedRoles?: string[];
  /** 本会话已成功读取的技能文件（规范化相对路径，小写）；由 read_file 回填，用于保存前的强制审查校验 */
  readFiles?: Set<string>;
  waitingForUser?: boolean;
  scriptUnchanged?: boolean;
  parentSignal?: AbortSignal;
  mutationState?: VideoAgentMutationState;
  abortRequest?: (reason: VideoAgentTimeoutError) => void;
  fullVideoEdit?: {
    sourceAssetId: number;
    sourceDurationSec: number;
  };
}

interface ToolExecutionContext {
  abortSignal?: AbortSignal;
  mutationState?: VideoAgentMutationState;
}

@Injectable()
export class VideoToolsService {
  /** skills 目录绝对路径，作为 read_file / write_file 的沙箱根 */
  private readonly skillsDir = process.env.SKILLS_DIR
    ? path.resolve(process.env.SKILLS_DIR)
    : path.resolve(process.cwd(), 'src/video/skills');

  constructor(
    @InjectRepository(VideoAsset)
    private assetRepo: Repository<VideoAsset>,
    @InjectRepository(VideoScript)
    private scriptRepo: Repository<VideoScript>,
    @InjectRepository(VideoSession)
    private sessionRepo: Repository<VideoSession>,
    @InjectRepository(VideoTask)
    private taskRepo: Repository<VideoTask>,
    private storyboardParser: StoryboardParserService,
    private taskService: VideoTaskService,
    private seedancePromptValidator: SeedancePromptValidatorService,
    private readonly executionService: VideoAgentExecutionService,
  ) {}

  buildTools(ctx: ToolContext, role?: RoleProfile) {
    const allTools = {
      start_script_creation: this.buildStartScriptCreationTool(),
      read_file: this.buildReadFileTool(ctx),
      write_file: this.buildWriteFileTool(),
      update_creative_brief: this.buildUpdateCreativeBriefTool(ctx),
      generate_script: this.buildGenerateScriptTool(ctx),
      complete_without_script_change:
        this.buildCompleteWithoutScriptChangeTool(ctx),
      request_user_confirmation: this.buildRequestUserConfirmationTool(ctx),
      create_video_task: this.buildCreateVideoTaskTool(ctx),
      get_script: this.buildGetScriptTool(ctx),
      list_scripts: this.buildListScriptsTool(ctx),
      get_video_task_status: this.buildGetVideoTaskStatusTool(ctx),
      get_session_state: this.buildGetSessionStateTool(ctx),
    };

    // 不传角色时返回全量工具，作为编排层（Task 5）落地前的过渡行为
    const tools = role
      ? Object.fromEntries(
          Object.entries(allTools).filter(([name]) =>
            role.allowedTools.includes(name),
          ),
        )
      : allTools;

    return this.withExecutionDeadlines(tools, ctx);
  }

  private withExecutionDeadlines<T extends Record<string, any>>(
    tools: T,
    context: ToolContext,
  ): T {
    const executionService = this.executionService;

    return Object.fromEntries(
      Object.entries(tools).map(([toolName, definition]) => {
        const execute = definition.execute;
        if (!execute) return [toolName, definition];

        return [
          toolName,
          {
            ...definition,
            execute: async (input: unknown, sdkContext: ToolExecutionContext) => {
              const mutationState = context.mutationState ?? {
                sideEffectStarted: false,
              };
              const run =
                toolName === 'generate_script'
                  ? executionService.runScriptSave.bind(executionService)
                  : executionService.runTool.bind(executionService);

              try {
                return await run(
                  {
                    requestId: context.requestId,
                    sessionId: context.sessionId,
                    toolName,
                    parentSignal: context.parentSignal,
                    mutationState,
                  },
                  (signal) =>
                    execute(input, {
                      ...sdkContext,
                      abortSignal: signal,
                      mutationState,
                    }),
                );
              } catch (error) {
                if (
                  error instanceof VideoAgentTimeoutError &&
                  error.code === 'TOOL_TIMEOUT'
                ) {
                  context.abortRequest?.(error);
                }
                throw error;
              }
            },
          },
        ];
      }),
    ) as T;
  }

  private buildStartScriptCreationTool() {
    return tool({
      description:
        '开始一次分镜脚本创作流程。每轮用户明确要求生成、创作、重写或修改视频分镜脚本时都必须先调用本工具（同一会话中之前调用过也要重新调用，它不是一次性开关），并且必须在解析创作素材、读取创作规范或生成脚本之前调用；未调用前不得调用 generate_script。普通问候、素材分析、商品画像更新、知识问答和视频生成任务不得调用。',
      inputSchema: zodSchema(z.object({})),
      execute: async () => ({
        success: true,
        message: '已开始分镜脚本创作流程',
      }),
    });
  }

  private buildRequestUserConfirmationTool(ctx: ToolContext) {
    return tool({
      description:
        '当生成脚本或完整视频编辑任务缺少关键参数、存在不可自行推断的冲突，且必须等待用户确认后才能继续时调用。调用后停止本轮创作，不得调用 generate_script 或 create_video_task。',
      inputSchema: zodSchema(
        z.object({
          title: z.string().min(1).describe('过程面板中的确认事项标题'),
          description: z.string().min(1).describe('需要确认的原因和已知约束'),
          questions: z
            .array(
              z.object({
                field: z.string().min(1).describe('待确认字段名'),
                question: z.string().min(1).describe('向用户提出的具体问题'),
              }),
            )
            .min(1)
            .describe('需要用户回答的问题列表'),
        }),
      ),
      execute: async ({ title, description, questions }) => {
        ctx.waitingForUser = true;
        return {
          success: true,
          status: 'waiting_for_user',
          title,
          description,
          questions,
        };
      },
    });
  }

  private buildCompleteWithoutScriptChangeTool(ctx: ToolContext) {
    return tool({
      description:
        '当用户要求修改已有脚本，但目标脚本的实际内容已经满足该要求时调用。调用后停止本轮脚本创作，不得调用 generate_script。必须先调用 get_script 读取目标脚本后才能调用。',
      inputSchema: zodSchema(
        z.object({
          script_id: z
            .number()
            .int()
            .positive()
            .describe('已核对的现有脚本 ID'),
          description: z
            .string()
            .min(1)
            .describe('说明哪一个镜头或内容已经满足用户要求'),
        }),
      ),
      execute: async ({ script_id, description }) => {
        const script = await this.scriptRepo.findOne({
          where: {
            id: script_id,
            sessionId: ctx.sessionId,
            userId: ctx.userId,
          },
        });
        if (!script) {
          return { success: false, message: '目标脚本不存在或无权访问' };
        }
        ctx.scriptUnchanged = true;
        return {
          success: true,
          status: 'unchanged',
          script_id: script.id,
          version: script.version,
          description,
        };
      },
    });
  }

  /** 将用户传入的相对路径解析为 skills 目录内的绝对路径，防止路径穿越 */
  private resolveSkillPath(relativePath: string): string {
    const normalized = path.normalize(relativePath);
    const resolved = path.resolve(this.skillsDir, normalized);
    if (
      !resolved.startsWith(this.skillsDir + path.sep) &&
      resolved !== this.skillsDir
    ) {
      throw new Error(`路径越界：${relativePath} 不在 skills 目录内`);
    }
    return resolved;
  }

  /** 归一化技能相对路径（统一分隔符与小写），用于判断某文件是否已被读取过 */
  private normalizeSkillPath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  }

  /** 判断本轮是否已读取 sd2-pe 规则文件 */
  private hasReviewedSeedanceSkill(ctx: ToolContext): boolean {
    // 未启用读取追踪时不阻断，避免影响未接线的调用方
    if (!ctx.readFiles) return true;
    for (const file of ctx.readFiles) {
      if (file.endsWith('sd2-pe/skill.md')) return true;
    }
    return false;
  }

  private buildReadFileTool(ctx: ToolContext) {
    return tool({
      description:
        '按需读取视频创作指南和专项资料。核心路径：life-service-storyboard-generator/references/{routing,character,storyboard,seedance}.md；专项路径：life-service-storyboard-generator/references/type-configuration-center.md、seedance_2_0_template.md、sd2-pe/SKILL.md；效果问题排查手册（按症状检索）：sd2-pe/references/seedance-2-troubleshooting-guide.md、sd2-pe/references/typical-effect-cases.md。',
      inputSchema: zodSchema(
        z.object({
          path: z
            .string()
            .describe(
              '允许的按需路径：核心参考文件、type-configuration-center.md、seedance_2_0_template.md、sd2-pe/SKILL.md，或 sd2-pe/references 下的排查手册',
            ),
        }),
      ),
      execute: async ({ path: relativePath }) => {
        try {
          const fullPath = this.resolveSkillPath(relativePath);
          const content = await fs.readFile(fullPath, 'utf-8');
          ctx.readFiles?.add(this.normalizeSkillPath(relativePath));
          return { path: relativePath, content };
        } catch (err: any) {
          return { path: relativePath, error: err.message ?? '文件读取失败' };
        }
      },
    });
  }

  private buildWriteFileTool() {
    return tool({
      description:
        '将内容写入 skills 目录下的文件。路径相对于 skills 目录，例如 "life-service-storyboard-generator/docs/storyboards/商家名/2026-01-01_12-00-00/storyboard.md"。如果父目录不存在会自动创建。',
      inputSchema: zodSchema(
        z.object({
          path: z.string().describe('相对于 skills 目录的文件路径'),
          content: z.string().describe('要写入的文件内容'),
        }),
      ),
      execute: async (
        { path: relativePath, content },
        executionContext: ToolExecutionContext = {},
      ) => {
        try {
          const fullPath = this.resolveSkillPath(relativePath);
          await this.runAbortAware(executionContext, () =>
            fs.mkdir(path.dirname(fullPath), { recursive: true }),
          );
          await this.runAbortAware(executionContext, () =>
            fs.writeFile(fullPath, content, 'utf-8'),
          );
          return {
            path: relativePath,
            bytes: Buffer.byteLength(content, 'utf-8'),
            success: true,
          };
        } catch (err: any) {
          return {
            path: relativePath,
            error: err.message ?? '文件写入失败',
            success: false,
          };
        }
      },
    });
  }

  private buildUpdateCreativeBriefTool(ctx: ToolContext) {
    return tool({
      description:
        '当从对话中了解到创作信息（垂类、主题或商品名称、核心要点、目标人群、时长、平台、风格基调、额外约束）后，更新会话的创作简报，供后续轮次作为结构化上下文使用',
      inputSchema: zodSchema(
        z.object({
          vertical: z
            .string()
            .optional()
            .describe('创作垂类，例如 life-service'),
          subject: z.string().optional().describe('主题或商品名称'),
          key_points: z
            .array(z.string())
            .optional()
            .describe('核心要点／卖点列表'),
          audience: z.string().optional().describe('目标人群'),
          duration: z.number().optional().describe('目标视频时长（秒）'),
          platform: z.string().optional().describe('投放平台'),
          tone: z.string().optional().describe('风格基调'),
          constraints: z.array(z.string()).optional().describe('额外约束'),
        }),
      ),
      execute: async (
        profile,
        executionContext: ToolExecutionContext = {},
      ) => {
        const session = await this.sessionRepo.findOne({
          where: { sessionId: ctx.sessionId },
        });
        const incoming = Object.fromEntries(
          Object.entries(profile).filter(([, v]) => v !== undefined),
        );
        const merged = { ...(session?.creativeBrief || {}), ...incoming };
        await this.runAbortAware(
          executionContext,
          () =>
            this.sessionRepo.update(
              { sessionId: ctx.sessionId },
              { creativeBrief: merged },
            ),
        );
        return { success: true, profile: merged };
      },
    });
  }

  private buildGenerateScriptTool(ctx: ToolContext) {
    const editSchema = z.object({
      mode: z.literal('full_video_edit'),
      sourceAssetId: z.number().int().positive(),
      sourceDurationSec: z.number().positive(),
      targetStartSec: z.number().min(0),
      targetEndSec: z.number().positive(),
      preserveAudio: z.boolean(),
    });
    const editField = ctx.fullVideoEdit ? editSchema : editSchema.nullish();
    // 时长/画幅允许模型漏填，漏填时静默使用解析值或默认值，不触发工具重试
    const durationField = z.number().int().positive().nullish();
    const ratioField = z.enum(['9:16', '16:9', '1:1']).nullish();

    return tool({
      description: ctx.fullVideoEdit
        ? '当前请求已锁定为引用视频的完整视频编辑任务。meta.edit 为必填项，必须使用当前原视频素材和完整时长；用户未给出修改时间范围时应先追问，禁止保存普通分镜脚本。storyboard_markdown 必须包含可解析的任务镜头，格式为“### 镜头 1：视频局部编辑 (开始s - 结束s)”，并包含“画面描述”和“旁白”字段。调用前必须阅读 sd2-pe/SKILL.md 审查 seedance_prompt。'
        : '保存最终的分镜脚本，或保存基于已有视频的完整视频编辑任务。调用前必须阅读 sd2-pe/SKILL.md 审查 seedance_prompt。脚本重写时保存完整新脚本；完整视频编辑时 storyboard_markdown 仅包含可解析的视频编辑任务，seedance_prompt 必须要求输出原视频完整时长且仅修改目标时间段，meta.edit 必须提供原视频素材和时间范围。多镜头 seedance_prompt 只能按“镜头1 / 镜头2 / 镜头3”顺序描述，禁止复制 storyboard_markdown 中的秒数或时间码。不得只在对话中输出提示词。工具会接收 storyboard_markdown、seedance_prompt 和 meta，自动解析为结构化数据并写入数据库。seedance_prompt 中禁止出现 asset ID、素材编号或“参考图1”，人像统一写 <主体1>@图片1；meta.character 必须包含 mode 和 selectionSource。',
      inputSchema: zodSchema(
        z.object({
          title: z.string(),
          storyboard_markdown: z.string(),
          seedance_prompt: z.string(),
          meta: z.object({
            duration: durationField.describe(
              `视频总时长（秒，上限 ${MAX_VIDEO_DURATION_SEC} 秒），建议与 storyboard_markdown 的总时长一致；留空时按脚本解析结果或默认 ${MAX_VIDEO_DURATION_SEC} 秒处理`,
            ),
            ratio: ratioField.describe(
              '画幅比例，抖音/小红书竖屏使用 9:16；留空时按脚本解析结果或默认 9:16 处理',
            ),
            style: z.string().nullish().describe('视觉风格关键词'),
            platform: z.string().nullish().describe('投放平台，如 抖音 / 小红书'),
            description: z.string().optional(),
            hashtags: z.array(z.string()).optional(),
            character: z.object({
              mode: z.enum(['user_portrait', 'preset_avatar', 'none']),
              roleName: z.string().nullish(),
              rolePrompt: z.string().nullish(),
              primaryAssetId: z.number().int().positive().nullish(),
              presetAvatarId: z.string().nullish(),
              presetAlias: z.string().nullish(),
              outfit: z
                .object({
                  mode: z.enum(['preset', 'custom']),
                  presetOutfitId: z.string().nullish(),
                  customPrompt: z.string().nullish(),
                })
                .nullish(),
              selectionSource: z
                .enum(['user_explicit', 'auto_selected', 'inherited'])
                .default('auto_selected'),
            }),
            edit: editField,
          }),
        }),
      ),
      execute: async ({
        title,
        storyboard_markdown,
        seedance_prompt,
        meta,
      }, executionContext: ToolExecutionContext = {}) => {
        // 编排模式下要求先分派角色子 Agent，避免导演跳过流水线自行代写
        if (ctx.requireDispatch && (ctx.dispatchedRoles?.length ?? 0) === 0) {
          return {
            success: false,
            message:
              '编排模式下必须先调用 dispatch_role_agent 依次分派 screenwriter、shot-planner、cinematographer，汇总其产出后再保存脚本',
          };
        }
        // sd2-pe 是生成 Seedance 提示词的强制规范，保存前必须已读取并按其约束审查
        if (!this.hasReviewedSeedanceSkill(ctx)) {
          return {
            success: false,
            message:
              '保存 seedance_prompt 前必须先调用 read_file 读取 sd2-pe/SKILL.md，逐条落实其强制约束后再保存',
          };
        }
        if (ctx.waitingForUser || ctx.scriptUnchanged) {
          return {
            success: false,
            message: ctx.waitingForUser
              ? '本轮已等待用户确认，收到用户回复前不得保存脚本'
              : '本轮已确认目标脚本无需修改，不得保存重复版本',
          };
        }
        if (ctx.fullVideoEdit) {
          if (!meta.edit || meta.edit.mode !== 'full_video_edit') {
            return {
              success: false,
              message:
                '当前请求是引用视频修改，必须保存完整视频编辑任务并填写 meta.edit',
            };
          }
          if (
            meta.edit.sourceAssetId !== ctx.fullVideoEdit.sourceAssetId ||
            meta.edit.sourceDurationSec !== ctx.fullVideoEdit.sourceDurationSec
          ) {
            return {
              success: false,
              message: '视频编辑任务必须使用当前引用的原视频和完整时长',
            };
          }
        }

        // 主角色人像会作为第 1 张参考图传给模型，模型误写素材 ID 时自动替换为 @图片1
        const presetAvatarId = meta.character.presetAvatarId;
        const assetIdReplacements =
          meta.character.mode === 'preset_avatar' &&
          presetAvatarId &&
          isPresetAvatarId(presetAvatarId)
            ? { [presetAvatarId]: '@图片1' }
            : undefined;
        const normalization = this.seedancePromptValidator.normalize(
          seedance_prompt,
          { assetIdReplacements },
        );
        const validation = this.seedancePromptValidator.validate(
          normalization.prompt,
        );
        if (validation.errors.length > 0) {
          return {
            success: false,
            message: `Seedance 提示词未通过校验：${validation.errors.join('；')}`,
            warnings: validation.warnings,
          };
        }

        if (meta.character.mode === 'user_portrait') {
          if (!meta.character.primaryAssetId || meta.character.presetAvatarId) {
            return {
              success: false,
              message: '上传人像角色必须且只能绑定 primaryAssetId',
            };
          }
          if (meta.character.outfit) {
            return { success: false, message: '仅系统内置虚拟人支持预设服装' };
          }
          const portraitAsset = await this.assetRepo.findOne({
            where: {
              id: meta.character.primaryAssetId,
              sessionId: ctx.sessionId,
              userId: ctx.userId,
              assetType: 'image',
            },
          });
          if (!portraitAsset) {
            return {
              success: false,
              message: '主角色人像素材不存在或无权访问',
            };
          }
        } else if (meta.character.mode === 'preset_avatar') {
          if (
            !meta.character.presetAvatarId ||
            meta.character.primaryAssetId ||
            !isPresetAvatarId(meta.character.presetAvatarId)
          ) {
            return {
              success: false,
              message: '虚拟人像必须使用允许的预置人像 ID',
            };
          }
          const avatar = getPresetAvatar(meta.character.presetAvatarId);
          if (isLegacyAvatarAlias(meta.character.roleName)) {
            return {
              success: false,
              message:
                '该角色已下线，请选择小叶、程曦、青黛、小岚、瑶琴、云游或凌霜之一',
            };
          }
          if (meta.character.presetAlias !== avatar.alias) {
            return {
              success: false,
              message: '虚拟人像简称与预置人像 ID 不匹配',
            };
          }
          const outfitValidation = validateAvatarOutfitSelection(
            avatar,
            meta.character.outfit,
          );
          if (!outfitValidation.success) {
            return { success: false, message: outfitValidation.message };
          }
          meta.character.outfit = outfitValidation.outfit;
        } else {
          if (meta.character.primaryAssetId || meta.character.presetAvatarId) {
            return { success: false, message: '无人物脚本不能绑定人像素材' };
          }
          if (meta.character.outfit) {
            return { success: false, message: '仅系统内置虚拟人支持预设服装' };
          }
        }

        if (meta.edit) {
          if (
            meta.edit.targetStartSec >= meta.edit.targetEndSec ||
            meta.edit.targetEndSec > meta.edit.sourceDurationSec
          ) {
            return { success: false, message: '视频编辑时间范围无效' };
          }

          const sourceAsset = await this.assetRepo.findOne({
            where: {
              id: meta.edit.sourceAssetId,
              sessionId: ctx.sessionId,
              userId: ctx.userId,
              assetType: 'video',
            },
          });
          if (!sourceAsset) {
            return { success: false, message: '原视频素材不存在或无权访问' };
          }
        }

        const parsed = this.storyboardParser.parse(storyboard_markdown, {
          vertical: ctx.vertical,
        });
        if (meta.edit && parsed.shots.length === 0) {
          const time = `${meta.edit.targetStartSec}-${meta.edit.targetEndSec}s`;
          const scene = '视频局部编辑';
          parsed.shots = [
            {
              shot: 1,
              time,
              scene,
              visual:
                meta.description ||
                `仅修改 ${time} 时间段，其余画面保持原视频不变`,
              audio: meta.edit.preserveAudio ? '保留原视频音频' : '',
            },
          ];
          parsed.hook = scene;
          parsed.meta.duration = meta.edit.sourceDurationSec;
        }
        if (parsed.shots.length === 0) {
          return {
            success: false,
            message:
              '脚本未包含可解析的镜头。请使用“### 镜头 1：名称 (0s - 3s)”及画面描述、旁白字段重新生成。',
          };
        }

        const declaredDurationRaw = meta.edit
          ? meta.edit.sourceDurationSec
          : (meta.duration ?? parsed.meta.duration);
        const declaredDuration =
          typeof declaredDurationRaw === 'number' &&
          Number.isFinite(declaredDurationRaw)
            ? declaredDurationRaw
            : 0;
        const lastShotEndSec = Math.max(
          0,
          ...parsed.shots.map((shot) => {
            const match =
              typeof shot.time === 'string'
                ? shot.time.match(/-(\d+(?:\.\d+)?)s$/)
                : null;
            return match ? Number(match[1]) : 0;
          }),
        );
        const effectiveDuration = Math.max(declaredDuration, lastShotEndSec);
        // 引用视频修改沿用原视频时长，官方时长下限只约束新建脚本
        if (
          !meta.edit &&
          effectiveDuration > 0 &&
          effectiveDuration < MIN_VIDEO_DURATION_SEC
        ) {
          return {
            success: false,
            message: PROHIBITION_RULES.shortDuration.message,
          };
        }
        if (effectiveDuration > MAX_VIDEO_DURATION_SEC) {
          return {
            success: false,
            message: meta.edit
              ? `原视频时长 ${effectiveDuration} 秒超过模型单次生成上限 ${MAX_VIDEO_DURATION_SEC} 秒，无法生成完整视频编辑任务。`
              : `脚本总时长 ${effectiveDuration} 秒超过模型单次生成上限 ${MAX_VIDEO_DURATION_SEC} 秒，请压缩镜头，使最后一个镜头结束时间不超过 ${MAX_VIDEO_DURATION_SEC} 秒后重新保存。`,
          };
        }

        const nextVersion = await this.getNextVersion(ctx.sessionId);

        // 显式传入的 meta 优先于从 markdown 解析的默认值；未提供的字段不覆盖解析结果
        const mergedMeta: Record<string, unknown> = {
          ...parsed.meta,
          ...Object.fromEntries(
            Object.entries(meta).filter(
              ([, value]) => value !== undefined && value !== null,
            ),
          ),
        };
        // 完整视频编辑模式的时长/画幅以原视频为准
        if (meta.edit) {
          mergedMeta.duration = meta.edit.sourceDurationSec;
        }

        this.throwIfAborted(executionContext.abortSignal);
        const script = this.scriptRepo.create({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          version: nextVersion,
          title,
          hook: parsed.hook,
          shots: parsed.shots,
          scriptMarkdown: storyboard_markdown,
          seedancePrompt: normalization.prompt,
          meta: mergedMeta,
          sourceMessageId: ctx.currentMessageId,
          basedOnVersion: ctx.referencedVersion,
          status: 'draft',
        });

        const saved = await this.runAbortAware(
          executionContext,
          () => this.scriptRepo.save(script),
        );
        await this.runAbortAware(
          executionContext,
          () =>
            this.sessionRepo.update(
              { sessionId: ctx.sessionId },
              { status: 'script_generated' },
            ),
        );

        return {
          script_id: saved.id,
          version: saved.version,
          title: saved.title,
          shot_count: parsed.shots.length,
          message: `脚本 V${saved.version} 已保存。`,
          warnings: [...validation.warnings, ...normalization.changes],
        };
      },
    });
  }

  private buildCreateVideoTaskTool(ctx: ToolContext) {
    return tool({
      description:
        '用户确认使用某个脚本生成视频时，提交视频生成任务到火山引擎 Seedance。',
      inputSchema: zodSchema(
        z.object({
          script_id: z.number(),
        }),
      ),
      execute: async (
        { script_id },
        executionContext: ToolExecutionContext = {},
      ) => {
        if (ctx.waitingForUser) {
          return {
            success: false,
            message: '本轮已等待用户确认，收到用户回复前不得提交视频生成任务',
          };
        }
        const script = await this.scriptRepo.findOne({
          where: {
            id: script_id,
            sessionId: ctx.sessionId,
            userId: ctx.userId,
          },
        });
        if (!script) {
          return { success: false, message: '脚本不存在或无权访问' };
        }

        const task = await this.runAbortAware(
          executionContext,
          () =>
            this.taskService.createTaskByScriptId(script.id, {
              sessionId: ctx.sessionId,
              userId: ctx.userId,
              signal: executionContext.abortSignal,
            }),
        );

        return {
          success: true,
          task_id: task.taskId,
          script_id: script.id,
          status: task.status,
          message: '视频生成任务已提交，正在排队处理。',
        };
      },
    });
  }

  private buildGetScriptTool(ctx: ToolContext) {
    return tool({
      description:
        '查询当前会话中已保存的脚本。用户询问某个脚本、历史版本、分镜内容或 Seedance 2.0 提示词时调用。未指定脚本时查询最新版本；查询已保存的完整 Seedance 2.0 提示词时，include 必须使用 seedance_prompt 或 full。',
      inputSchema: zodSchema(
        z.object({
          script_id: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('脚本 ID；未提供时可按 version 或最新版本查询'),
          version: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('脚本版本号'),
          include: z
            .enum(['summary', 'storyboard', 'seedance_prompt', 'full'])
            .default('summary')
            .describe(
              '返回内容范围；用户明确要求提示词时使用 seedance_prompt 或 full',
            ),
        }),
      ),
      execute: async ({ script_id, version, include }) => {
        let script: VideoScript | null;
        if (script_id) {
          script = await this.scriptRepo.findOne({
            where: {
              id: script_id,
              sessionId: ctx.sessionId,
              userId: ctx.userId,
            },
          });
        } else if (version) {
          script = await this.scriptRepo.findOne({
            where: { version, sessionId: ctx.sessionId, userId: ctx.userId },
          });
        } else {
          script = await this.scriptRepo.findOne({
            where: { sessionId: ctx.sessionId, userId: ctx.userId },
            order: { version: 'DESC' },
          });
        }

        if (!script) {
          return { success: false, message: '未找到当前会话中的对应脚本。' };
        }

        const summary = {
          script_id: script.id,
          version: script.version,
          title: script.title,
          status: script.status,
          shot_count: script.shots.length,
          created_at: this.toISOString(script.createdAt),
        };

        if (include === 'summary') {
          return { success: true, script: summary };
        }
        if (include === 'storyboard') {
          return {
            success: true,
            script: { ...summary, storyboard_markdown: script.scriptMarkdown },
          };
        }
        if (include === 'seedance_prompt') {
          return {
            success: true,
            script: { ...summary, seedance_prompt: script.seedancePrompt },
          };
        }
        return {
          success: true,
          script: {
            ...summary,
            storyboard_markdown: script.scriptMarkdown,
            seedance_prompt: script.seedancePrompt,
            meta: script.meta,
          },
        };
      },
    });
  }

  private buildListScriptsTool(ctx: ToolContext) {
    return tool({
      description:
        '列出当前会话已保存的脚本版本。用户提到“上一版”“历史脚本”或需要在多个脚本中选择时调用；需要完整内容时再调用 get_script。',
      inputSchema: zodSchema(
        z.object({
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .default(10)
            .describe('最多返回的脚本数量'),
        }),
      ),
      execute: async ({ limit }) => {
        const scripts = await this.scriptRepo.find({
          where: { sessionId: ctx.sessionId, userId: ctx.userId },
          order: { version: 'DESC' },
          take: limit,
        });

        return {
          success: true,
          scripts: scripts.map((script) => ({
            script_id: script.id,
            version: script.version,
            title: script.title,
            status: script.status,
            shot_count: script.shots.length,
            created_at: this.toISOString(script.createdAt),
          })),
        };
      },
    });
  }

  private buildGetVideoTaskStatusTool(ctx: ToolContext) {
    return tool({
      description:
        '查询当前会话的视频生成任务状态。用户询问视频是否生成完成、任务进度、结果视频或失败原因时调用。未指定 task_id 时优先返回最近的进行中任务，否则返回最近任务。',
      inputSchema: zodSchema(
        z.object({
          task_id: z
            .string()
            .optional()
            .describe('视频生成任务 ID；未提供时查询最近任务'),
        }),
      ),
      execute: async ({ task_id }) => {
        let task: VideoTask | null;
        if (task_id) {
          task = await this.taskRepo.findOne({
            where: {
              taskId: task_id,
              sessionId: ctx.sessionId,
              userId: ctx.userId,
            },
          });
        } else {
          task =
            (await this.taskRepo.findOne({
              where: {
                sessionId: ctx.sessionId,
                userId: ctx.userId,
                status: 'running',
              },
              order: { updatedAt: 'DESC' },
            })) ??
            (await this.taskRepo.findOne({
              where: {
                sessionId: ctx.sessionId,
                userId: ctx.userId,
                status: 'queued',
              },
              order: { updatedAt: 'DESC' },
            })) ??
            (await this.taskRepo.findOne({
              where: { sessionId: ctx.sessionId, userId: ctx.userId },
              order: { updatedAt: 'DESC' },
            }));
        }

        if (!task) {
          return {
            success: false,
            message: '当前会话没有可查询的视频生成任务。',
          };
        }

        const script = task.scriptId
          ? await this.scriptRepo.findOne({
              where: {
                id: task.scriptId,
                sessionId: ctx.sessionId,
                userId: ctx.userId,
              },
            })
          : null;

        return {
          success: true,
          task: {
            task_id: task.taskId,
            status: task.status,
            script_id: task.scriptId,
            script_version: script?.version,
            script_title: script?.title,
            model: task.model,
            duration: task.duration,
            resolution: task.resolution,
            ratio: task.ratio,
            generated_video_url: task.generatedVideoUrl,
            last_frame_url: task.lastFrameUrl,
            error_code: task.errorCode,
            error_message: task.errorMessage,
            created_at: this.toISOString(task.createdAt),
            updated_at: this.toISOString(task.updatedAt),
          },
        };
      },
    });
  }

  private buildGetSessionStateTool(ctx: ToolContext) {
    return tool({
      description:
        '查询当前会话的持久化状态摘要，包括商品画像、最新脚本、最近视频任务和素材数量。用户询问“当前做到哪一步”“会话状态”或需要确认当前上下文时调用。',
      inputSchema: zodSchema(z.object({})),
      execute: async () => {
        const [session, latestScript, activeTask, assets] = await Promise.all([
          this.sessionRepo.findOne({
            where: { sessionId: ctx.sessionId, userId: ctx.userId },
          }),
          this.scriptRepo.findOne({
            where: { sessionId: ctx.sessionId, userId: ctx.userId },
            order: { version: 'DESC' },
          }),
          this.taskRepo.findOne({
            where: {
              sessionId: ctx.sessionId,
              userId: ctx.userId,
              status: 'running',
            },
            order: { updatedAt: 'DESC' },
          }),
          this.assetRepo.find({
            where: { sessionId: ctx.sessionId, userId: ctx.userId },
          }),
        ]);
        const recentTask =
          activeTask ??
          (await this.taskRepo.findOne({
            where: { sessionId: ctx.sessionId, userId: ctx.userId },
            order: { updatedAt: 'DESC' },
          }));

        if (!session) {
          return { success: false, message: '当前会话不存在或无权访问。' };
        }

        return {
          success: true,
          session: {
            session_id: session.sessionId,
            status: session.status,
            topic: session.topic,
            product_profile: session.creativeBrief,
            latest_script: latestScript
              ? {
                  script_id: latestScript.id,
                  version: latestScript.version,
                  title: latestScript.title,
                  status: latestScript.status,
                }
              : null,
            video_task: recentTask
              ? {
                  task_id: recentTask.taskId,
                  status: recentTask.status,
                  script_id: recentTask.scriptId,
                  generated_video_url: recentTask.generatedVideoUrl,
                  error_message: recentTask.errorMessage,
                  updated_at: this.toISOString(recentTask.updatedAt),
                }
              : null,
            assets: {
              total: assets.length,
              analysis: assets.filter((asset) =>
                ['analysis', 'all'].includes(asset.assetPurpose),
              ).length,
              reference: assets.filter((asset) =>
                ['reference', 'all'].includes(asset.assetPurpose),
              ).length,
            },
            updated_at: this.toISOString(session.updatedAt),
          },
        };
      },
    });
  }

  private async getNextVersion(sessionId: string): Promise<number> {
    const latest = await this.scriptRepo.findOne({
      where: { sessionId },
      order: { version: 'DESC' },
    });
    return (latest?.version ?? 0) + 1;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Video agent execution was aborted');
    }
  }

  private async runAbortAware<T>(
    executionContext: ToolExecutionContext,
    mutation: () => Promise<T>,
  ): Promise<T> {
    this.throwIfAborted(executionContext.abortSignal);
    if (executionContext.mutationState) {
      executionContext.mutationState.sideEffectStarted = true;
    }
    const result = await mutation();
    this.throwIfAborted(executionContext.abortSignal);
    return result;
  }

  private toISOString(value: Date | null | undefined): string | null {
    return value ? value.toISOString() : null;
  }
}
