import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ContinuationMeta,
  VideoContinuityMode,
  VideoGenerationPlan,
} from './entities/video-generation-plan.entity';
import { VideoTask } from './entities/video-task.entity';
import { VideoScript } from './entities/video-script.entity';
import { VideoTaskService } from './video-task.service';
import { SeedancePromptValidatorService } from './seedance-prompt-validator.service';
import type { Shot } from './storyboard-parser.service';
import {
  DEFAULT_SEGMENT_DURATION_SEC,
  PlannedSegment,
  planVideoSegments,
  resolveTargetDuration,
  toRequestDuration,
} from './video-segment-planner';
import { buildSegmentPrompt } from './video-segment-prompt';

interface GenerationAsset {
  type: 'image' | 'video';
  url: string;
  name?: string;
}

export interface CreatePlanOptions {
  sessionId?: string;
  userId?: number;
  userPrompt?: string;
  assets?: GenerationAsset[];
  signal?: AbortSignal;
}

const CONTINUITY_MODES: VideoContinuityMode[] = ['extend', 'frame_bridge'];

@Injectable()
export class VideoGenerationPlanService {
  private readonly logger = new Logger(VideoGenerationPlanService.name);

  constructor(
    @InjectRepository(VideoGenerationPlan)
    private planRepo: Repository<VideoGenerationPlan>,
    @InjectRepository(VideoTask)
    private taskRepo: Repository<VideoTask>,
    @InjectRepository(VideoScript)
    private scriptRepo: Repository<VideoScript>,
    private taskService: VideoTaskService,
    private seedancePromptValidator: SeedancePromptValidatorService,
  ) {}

  /** 按脚本创建分段生成计划，并立即生成第 1 段 */
  async createPlan(scriptId: number, options: CreatePlanOptions = {}) {
    const script = await this.loadScript(
      scriptId,
      options.userId,
      options.sessionId,
    );
    // 局部视频编辑复用原片时长，不存在"多段创作"语义，不允许分段生成
    if (script.meta?.edit) {
      throw new BadRequestException(
        '局部视频编辑不支持分段生成，请使用普通生成',
      );
    }
    const targetDuration = this.readTargetDuration(script);
    const segments = planVideoSegments({
      shots: this.readShots(script),
      targetDuration,
      segmentDuration: DEFAULT_SEGMENT_DURATION_SEC,
    });

    if (segments.length < 2) {
      throw new BadRequestException(
        '脚本总时长未超过单段生成上限，请使用普通生成',
      );
    }

    const plan = await this.planRepo.save(
      this.planRepo.create({
        sessionId: script.sessionId,
        userId: script.userId,
        scriptId: script.id,
        targetDuration,
        segmentDuration: DEFAULT_SEGMENT_DURATION_SEC,
        totalSegments: segments.length,
        completedSegments: 0,
        status: 'generating',
      }),
    );

    await this.createSegmentTask(script, plan, segments[0], {
      continuityMode: 'extend',
      userPrompt: options.userPrompt,
      assets: options.assets,
      signal: options.signal,
    });

    return this.buildPlanPayload(
      plan,
      script,
      segments,
      await this.listPlanTasks(plan.id),
    );
  }

  /** 查询计划详情：计划 + 分段规划 + 各段任务 */
  async getPlan(planId: number, userId?: number) {
    const plan = await this.loadPlan(planId, userId);
    const script = await this.loadScript(plan.scriptId, userId);
    const segments = this.recomputeSegments(plan, script);
    const tasks = await this.listPlanTasks(plan.id);
    return this.buildPlanPayload(plan, script, segments, tasks);
  }

  /** 用户确认上一段后，按选择的衔接方式生成下一段 */
  async startNextSegment(
    planId: number,
    continuityMode: VideoContinuityMode,
    userId?: number,
  ) {
    this.assertContinuityMode(continuityMode);
    const plan = await this.loadPlan(planId, userId);
    this.assertPlanActive(plan);

    const script = await this.loadScript(plan.scriptId, userId);
    const segments = this.recomputeSegments(plan, script);

    const succeeded = await this.countSucceeded(plan.id);
    if (succeeded >= plan.totalSegments) {
      plan.status = 'completed';
      await this.planRepo.save(plan);
      throw new BadRequestException('视频已全部生成完成，无需继续生成');
    }

    const nextIndex = succeeded + 1;
    const segment = segments[nextIndex - 1];
    const prevTask =
      nextIndex > 1
        ? await this.requireSegmentTask(plan.id, nextIndex - 1)
        : null;

    await this.createSegmentTask(script, plan, segment, {
      continuityMode,
      prevTask,
    });

    plan.completedSegments = succeeded;
    plan.status = 'generating';
    await this.planRepo.save(plan);

    return this.buildPlanPayload(
      plan,
      script,
      segments,
      await this.listPlanTasks(plan.id),
    );
  }

  /** 重抽指定段：该段及其之后的段全部作废后重新生成 */
  async regenerateSegment(
    planId: number,
    segmentIndex: number,
    continuityMode: VideoContinuityMode,
    userId?: number,
  ) {
    this.assertContinuityMode(continuityMode);
    const plan = await this.loadPlan(planId, userId);
    this.assertPlanActive(plan);

    if (
      !Number.isInteger(segmentIndex) ||
      segmentIndex < 1 ||
      segmentIndex > plan.totalSegments
    ) {
      throw new BadRequestException(
        `分段序号无效，应在 1-${plan.totalSegments} 之间`,
      );
    }

    const script = await this.loadScript(plan.scriptId, userId);
    const segments = this.recomputeSegments(plan, script);
    const prevTask =
      segmentIndex > 1
        ? await this.requireSegmentTask(plan.id, segmentIndex - 1)
        : null;

    await this.voidSegmentsFrom(plan, segmentIndex);

    await this.createSegmentTask(script, plan, segments[segmentIndex - 1], {
      continuityMode,
      prevTask,
    });

    plan.completedSegments = await this.countSucceeded(plan.id);
    plan.status = 'generating';
    await this.planRepo.save(plan);

    return this.buildPlanPayload(
      plan,
      script,
      segments,
      await this.listPlanTasks(plan.id),
    );
  }

  /** 取消计划，并尽力取消尚未完成的分段任务 */
  async cancelPlan(planId: number, userId?: number) {
    const plan = await this.loadPlan(planId, userId);
    if (plan.status === 'cancelled') {
      return this.getPlan(planId, userId);
    }

    const tasks = await this.listPlanTasks(plan.id);
    for (const task of tasks) {
      if (task.status === 'succeeded') continue;
      await this.taskService.voidTask(task);
    }

    plan.status = 'cancelled';
    await this.planRepo.save(plan);

    return this.getPlan(planId, userId);
  }

  private async createSegmentTask(
    script: VideoScript,
    plan: VideoGenerationPlan,
    segment: PlannedSegment,
    options: {
      continuityMode: VideoContinuityMode;
      prevTask?: VideoTask | null;
      userPrompt?: string;
      assets?: GenerationAsset[];
      signal?: AbortSignal;
    },
  ) {
    // 续写脚本的第 1 段接着原片生成，衔接方式取用户选择；其余段沿用面板选择
    const continuityMode =
      segment.index === 1
        ? this.firstSegmentContinuityMode(script)
        : options.continuityMode;
    const continuation =
      segment.index === 1
        ? await this.taskService.resolveContinuationInput(
            script,
            continuityMode,
          )
        : null;

    const prompt = this.buildPrompt(
      script,
      segment,
      continuityMode,
      plan.totalSegments,
    );

    return this.taskService.createTaskByScriptId(script.id, {
      sessionId: script.sessionId,
      userId: script.userId,
      userPrompt: options.userPrompt,
      assets: options.assets,
      signal: options.signal,
      segment: {
        planId: plan.id,
        segmentIndex: segment.index,
        prompt,
        duration: toRequestDuration(segment, plan.segmentDuration),
        continuityMode,
        prevTask: options.prevTask ?? null,
        continuation: continuation ?? undefined,
      },
    });
  }

  /** 续写脚本第 1 段承接原片，衔接方式取用户选择；普通脚本第 1 段固定延长 */
  private firstSegmentContinuityMode(script: VideoScript): VideoContinuityMode {
    const mode = (script.meta?.continuation as ContinuationMeta | undefined)
      ?.continuityMode;
    return mode === 'frame_bridge' ? 'frame_bridge' : 'extend';
  }

  /** 面板需要标注「第 1 段承接原片」，来源直接从脚本 meta 回读 */
  private readContinuation(script: VideoScript): {
    sourceDurationSec: number;
    continuityMode: VideoContinuityMode;
  } | null {
    const continuation = script.meta?.continuation as
      | ContinuationMeta
      | undefined;
    if (!continuation || continuation.mode !== 'continuation') {
      return null;
    }
    return {
      sourceDurationSec: continuation.sourceDurationSec,
      continuityMode: this.firstSegmentContinuityMode(script),
    };
  }

  /** 段级提示词：复用脚本全局设定与原始镜头块，只保留本段镜头并写明衔接要求 */
  private buildPrompt(
    script: VideoScript,
    segment: PlannedSegment,
    continuityMode: VideoContinuityMode,
    totalSegments: number,
  ): string {
    const raw = buildSegmentPrompt({
      title: script.title,
      meta: script.meta,
      seedancePrompt: script.seedancePrompt,
      scriptShotCount: (script.shots ?? []).length,
      segment,
      totalSegments,
      continuityMode,
    });

    const { prompt } = this.seedancePromptValidator.normalize(raw);
    const { errors, warnings } = this.seedancePromptValidator.validate(prompt);
    if (errors.length > 0) {
      throw new BadRequestException(
        `第 ${segment.index} 段提示词未通过校验：${errors.join('；')}`,
      );
    }
    if (warnings.length > 0) {
      this.logger.warn(
        `第 ${segment.index} 段提示词告警：${warnings.join('；')}`,
      );
    }

    return prompt;
  }

  private readShots(script: VideoScript): Shot[] {
    return (script.shots ?? []) as Shot[];
  }

  private recomputeSegments(
    plan: VideoGenerationPlan,
    script: VideoScript,
  ): PlannedSegment[] {
    return planVideoSegments({
      shots: this.readShots(script),
      targetDuration: plan.targetDuration,
      segmentDuration: plan.segmentDuration,
    });
  }

  private readTargetDuration(script: VideoScript): number {
    const duration = resolveTargetDuration(
      this.readShots(script),
      script.meta?.duration,
    );
    if (duration <= 0) {
      throw new BadRequestException('脚本缺少有效总时长，无法规划分段生成');
    }
    return duration;
  }

  private async loadPlan(
    planId: number,
    userId?: number,
  ): Promise<VideoGenerationPlan> {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) {
      throw new BadRequestException(`分段生成计划不存在: ${planId}`);
    }
    if (userId && plan.userId !== userId) {
      throw new BadRequestException('无权访问该分段生成计划');
    }
    return plan;
  }

  private async loadScript(
    scriptId: number,
    userId?: number,
    sessionId?: string,
  ): Promise<VideoScript> {
    const script = await this.scriptRepo.findOne({ where: { id: scriptId } });
    if (!script) {
      throw new BadRequestException(`脚本不存在: ${scriptId}`);
    }
    if (userId && script.userId !== userId) {
      throw new BadRequestException('无权使用该脚本生成视频');
    }
    if (sessionId && script.sessionId !== sessionId) {
      throw new BadRequestException('脚本不属于当前会话');
    }
    return script;
  }

  private assertPlanActive(plan: VideoGenerationPlan) {
    if (plan.status === 'cancelled') {
      throw new BadRequestException('该分段生成计划已取消');
    }
    if (plan.status === 'completed') {
      throw new BadRequestException('视频已全部生成完成，无需继续生成');
    }
  }

  private assertContinuityMode(mode: VideoContinuityMode) {
    if (!CONTINUITY_MODES.includes(mode)) {
      throw new BadRequestException(
        '衔接方式无效，应为 extend（延长上一段）或 frame_bridge（尾帧作首帧）',
      );
    }
  }

  private listPlanTasks(planId: number): Promise<VideoTask[]> {
    return this.taskRepo.find({
      where: { planId },
      order: { segmentIndex: 'ASC', createdAt: 'ASC' },
    });
  }

  private countSucceeded(planId: number): Promise<number> {
    return this.taskRepo.count({ where: { planId, status: 'succeeded' } });
  }

  private async requireSegmentTask(
    planId: number,
    segmentIndex: number,
  ): Promise<VideoTask> {
    const task = await this.taskRepo.findOne({
      where: { planId, segmentIndex, status: 'succeeded' },
    });
    if (!task) {
      throw new BadRequestException(
        `第 ${segmentIndex} 段尚未生成成功，请先生成并确认该段`,
      );
    }
    return task;
  }

  /** 作废从 fromIndex 开始的分段任务（续接依赖链会被破坏，必须整体重生成） */
  private async voidSegmentsFrom(plan: VideoGenerationPlan, fromIndex: number) {
    const tasks = await this.listPlanTasks(plan.id);
    for (const task of tasks) {
      if ((task.segmentIndex ?? 0) < fromIndex) continue;
      await this.taskService.voidTask(task);
    }
  }

  private buildPlanPayload(
    plan: VideoGenerationPlan,
    script: VideoScript,
    segments: PlannedSegment[],
    tasks?: VideoTask[],
  ) {
    return {
      planId: plan.id,
      sessionId: plan.sessionId,
      scriptId: plan.scriptId,
      targetDuration: plan.targetDuration,
      segmentDuration: plan.segmentDuration,
      totalSegments: plan.totalSegments,
      completedSegments: plan.completedSegments,
      status: plan.status,
      assembledVideoUrl: plan.assembledVideoUrl,
      scriptTitle: script.title,
      ratio: typeof script.meta?.ratio === 'string' ? script.meta.ratio : null,
      continuation: this.readContinuation(script),
      segments: segments.map((segment) => ({
        index: segment.index,
        startSec: segment.startSec,
        endSec: segment.endSec,
        duration: segment.duration,
        requestDuration: toRequestDuration(segment, plan.segmentDuration),
        shotCount: segment.shots.length,
        shots: segment.shots.map((shot) => ({
          shot: shot.shot,
          scene: shot.scene,
          continues: shot.continues,
          hasAudio: Boolean(shot.audio),
        })),
      })),
      tasks: (tasks ?? []).map((task) => ({
        taskId: task.taskId,
        segmentIndex: task.segmentIndex,
        status: task.status,
        continuityMode: task.continuityMode,
        duration: task.duration,
        generatedVideoUrl: task.generatedVideoUrl,
        lastFrameUrl: task.lastFrameUrl,
        errorMessage: task.errorMessage,
      })),
    };
  }
}
