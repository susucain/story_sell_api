import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { Observable, Subscriber } from 'rxjs';
import Redis from 'ioredis';
import { VideoTask } from './entities/video-task.entity';
import {
  ContinuationMeta,
  VideoContinuityMode,
  VideoGenerationPlan,
} from './entities/video-generation-plan.entity';
import { VideoScript } from './entities/video-script.entity';
import { VideoAsset } from './entities/video-asset.entity';
import { VideoSession } from './entities/video-session.entity';
import { VideoMessage } from './entities/video-message.entity';
import { OssService } from '../oss/oss.service';
import {
  AvatarOutfitInput,
  getPresetAvatar,
  isPresetAvatarId,
  PresetAvatarId,
  validateAvatarOutfitSelection,
} from './avatar-catalog';
import { ASSET_REF_LIMITS } from './seedance-rules';

interface TaskUpdatePayload {
  taskId: string;
  status: string;
  generatedVideoUrl?: string;
  errorMessage?: string;
}

interface GenerationAsset {
  type: 'image' | 'video';
  url: string;
  name?: string;
}

/** 分段生成：单段的任务参数 */
interface SegmentGenerationOptions {
  planId: number;
  /** 段序号，从 1 开始 */
  segmentIndex: number;
  prompt: string;
  duration: number;
  continuityMode: VideoContinuityMode;
  /** 上一段任务；第 1 段为空 */
  prevTask?: VideoTask | null;
  /** 续写脚本的第 1 段：以原片为续接输入，按衔接方式二选一 */
  continuation?: { videoUrl?: string; lastFrameUrl?: string };
}

interface CreateTaskByScriptOptions {
  sessionId?: string;
  userId?: number;
  userPrompt?: string;
  assets?: GenerationAsset[];
  signal?: AbortSignal;
  /** 存在时按分段生成该段，改用段级提示词与续接输入 */
  segment?: SegmentGenerationOptions;
}

interface FullVideoEditMeta {
  mode: 'full_video_edit';
  sourceAssetId: number;
  sourceDurationSec: number;
  targetStartSec: number;
  targetEndSec: number;
  preserveAudio: boolean;
}

interface CharacterMeta {
  mode: 'user_portrait' | 'preset_avatar' | 'none';
  primaryAssetId?: number;
  presetAvatarId?: PresetAvatarId;
  presetAlias?: string;
  outfit?: AvatarOutfitInput;
}

/** 视频模型单次生成的时长上限（秒） */
export const MAX_VIDEO_DURATION_SEC = 15;

const TASK_STATUSES = [
  'queued',
  'running',
  'persisting',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
] as const;
const TERMINAL_TASK_STATUSES = new Set<string>([
  'succeeded',
  'failed',
  'expired',
  'cancelled',
]);
const TASK_STATUS_ORDER: Record<string, number> = {
  queued: 0,
  running: 1,
  persisting: 2,
  succeeded: 3,
  failed: 3,
  expired: 3,
  cancelled: 3,
};

@Injectable()
export class VideoTaskService {
  private readonly logger = new Logger(VideoTaskService.name);
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly apiModel: string;
  private readonly redis: Redis;
  private readonly subscribers = new Map<string, Set<Subscriber<any>>>();

  constructor(
    @InjectRepository(VideoTask)
    private videoTaskRepo: Repository<VideoTask>,
    @InjectRepository(VideoScript)
    private scriptRepo: Repository<VideoScript>,
    @InjectRepository(VideoAsset)
    private assetRepo: Repository<VideoAsset>,
    @InjectRepository(VideoSession)
    private sessionRepo: Repository<VideoSession>,
    @InjectRepository(VideoMessage)
    private messageRepo: Repository<VideoMessage>,
    @InjectRepository(VideoGenerationPlan)
    private planRepo: Repository<VideoGenerationPlan>,
    @InjectQueue('video-tasks')
    private taskQueue: Queue,
    private configService: ConfigService,
    private ossService: OssService,
  ) {
    this.apiKey = this.configService.get<string>('YUNFEI_API_KEY') || '';
    this.apiUrl = this.configService.get<string>('YUNFEI_API_URL') || '';
    this.apiModel = this.configService.get<string>('YUNFEI_API_MODEL') || '';

    const redisUrl = this.configService.get<string>('REDIS_URL');
    this.redis = redisUrl
      ? new Redis(redisUrl)
      : new Redis({
          host: this.configService.get<string>('REDIS_HOST') || 'localhost',
          port: Number(this.configService.get<string>('REDIS_PORT') || 6379),
          password:
            this.configService.get<string>('REDIS_PASSWORD') || undefined,
        });

    this.startRedisSubscriber();
  }

  private startRedisSubscriber() {
    const subscriber = new Redis(this.redis.options);
    subscriber.subscribe('video-task-updates', (err) => {
      if (err) {
        this.logger.error('Redis subscribe failed', err);
      }
    });
    subscriber.on('message', (channel, message) => {
      if (channel !== 'video-task-updates') return;
      try {
        const payload: TaskUpdatePayload = JSON.parse(message);
        this.broadcast(payload);
      } catch (e) {
        this.logger.error('Failed to parse redis message', e);
      }
    });
  }

  private broadcast(payload: TaskUpdatePayload) {
    const subs = this.subscribers.get(payload.taskId);
    if (!subs) return;
    for (const sub of subs) {
      sub.next({ data: payload });
      if (TERMINAL_TASK_STATUSES.has(payload.status)) {
        sub.complete();
      }
    }
  }

  /**
   * 创建视频生成任务（内部工具调用）
   */
  async createTask(params: {
    sessionId: string;
    userId: number;
    scriptId: number;
    prompt: string;
    imageUrls?: string[];
    videoUrls?: string[];
    /** 首帧约束图（上一段尾帧）；传入时本任务属于「图生视频-首帧」场景 */
    firstFrameUrl?: string;
    duration?: number;
    ratio?: string;
    planId?: number;
    segmentIndex?: number;
    prevTaskId?: string;
    continuityMode?: VideoContinuityMode;
    signal?: AbortSignal;
  }) {
    this.throwIfAborted(params.signal);
    const content: any[] = [{ type: 'text', text: params.prompt }];

    // 官方约束：图生视频-首尾帧与多模态参考生视频是互斥场景，不可混用
    if (params.firstFrameUrl) {
      if (
        (params.imageUrls?.length ?? 0) > 0 ||
        (params.videoUrls?.length ?? 0) > 0
      ) {
        throw new BadRequestException(
          '首帧约束模式不能同时传入参考图或参考视频，请二选一',
        );
      }
      content.push({
        type: 'image_url',
        image_url: { url: params.firstFrameUrl },
        role: 'first_frame',
      });
    } else {
      if (params.imageUrls && params.imageUrls.length > 0) {
        for (const url of params.imageUrls) {
          content.push({
            type: 'image_url',
            image_url: { url },
            role: 'reference_image',
          });
        }
      }

      if (params.videoUrls && params.videoUrls.length > 0) {
        for (const url of params.videoUrls) {
          content.push({
            type: 'video_url',
            video_url: { url },
            role: 'reference_video',
          });
        }
      }
    }

    const { duration = MAX_VIDEO_DURATION_SEC, ratio = '9:16' } = params;

    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > MAX_VIDEO_DURATION_SEC
    ) {
      throw new BadRequestException(
        `视频时长必须在 1-${MAX_VIDEO_DURATION_SEC} 秒之间，当前为 ${duration} 秒`,
      );
    }

    const requestBody: any = {
      model: this.apiModel,
      content,
      duration,
      ratio,
      return_last_frame: true,
      resolution: '720p',
    };

    requestBody.callback_url = this.getCallbackUrl();

    this.logger.log(
      JSON.stringify({
        event: 'video_task_submit',
        model: this.apiModel,
        duration,
        ratio,
        imageCount: params.imageUrls?.length ?? 0,
        videoCount: params.videoUrls?.length ?? 0,
      }),
    );

    const response = await fetch(this.apiUrl, {
      // const response = await fetch('', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(`视频生成服务请求失败: HTTP ${response.status}`);
    }

    const data = await response.json();
    this.throwIfAborted(params.signal);
    this.logger.log(
      JSON.stringify({
        event: 'video_task_provider_response',
        taskId: data.id,
        status: data.status || 'queued',
        model: data.model || this.apiModel,
      }),
    );

    const task = this.videoTaskRepo.create({
      sessionId: params.sessionId,
      userId: params.userId,
      scriptId: params.scriptId,
      taskId: data.id,
      model: data.model || this.apiModel,
      status: data.status || 'queued',
      prompt: params.prompt,
      imageUrls: params.imageUrls
        ? JSON.stringify(params.imageUrls)
        : undefined,
      videoUrls: params.videoUrls
        ? JSON.stringify(params.videoUrls)
        : undefined,
      duration,
      ratio,
      resolution: '720p',
      planId: params.planId,
      segmentIndex: params.segmentIndex,
      prevTaskId: params.prevTaskId,
      continuityMode: params.continuityMode,
      volcResponse: JSON.stringify(data),
    });

    this.throwIfAborted(params.signal);
    await this.videoTaskRepo.save(task);

    return task;
  }

  /**
   * 通过脚本 ID 创建任务（Controller 调用）
   */
  async createTaskByScriptId(
    scriptId: number,
    options: CreateTaskByScriptOptions = {},
  ) {
    this.throwIfAborted(options.signal);
    const script = await this.scriptRepo.findOne({ where: { id: scriptId } });
    if (!script) {
      throw new Error(`脚本不存在: ${scriptId}`);
    }

    if (options.sessionId && options.sessionId !== script.sessionId) {
      throw new Error('脚本不属于当前会话');
    }
    if (options.userId && options.userId !== script.userId) {
      throw new Error('无权使用该脚本生成视频');
    }

    const suppliedAssets = options.assets ?? [];
    for (const asset of suppliedAssets) {
      const existing = await this.assetRepo.findOne({
        where: {
          sessionId: script.sessionId,
          userId: script.userId,
          url: asset.url,
        },
      });
      if (existing) {
        if (existing.assetPurpose === 'analysis') {
          existing.assetPurpose = 'all';
          existing.status = 'parsed';
          this.throwIfAborted(options.signal);
          await this.assetRepo.save(existing);
        }
        continue;
      }

      this.throwIfAborted(options.signal);
      await this.assetRepo.save(
        this.assetRepo.create({
          sessionId: script.sessionId,
          userId: script.userId,
          assetType: asset.type,
          assetPurpose: 'all',
          name: asset.name || '视频生成参考素材',
          url: asset.url,
          status: 'parsed',
        }),
      );
    }

    // 分段生成：每段都带主角色人像/会话参考图，并叠加上一段的成片/尾帧作为续接输入
    if (options.segment) {
      return this.createSegmentTask(script, options.segment, options.signal);
    }

    const fullVideoEdit = await this.resolveFullVideoEdit(script);
    // 续写脚本：首段接着原片生成，只参考原片本身，不掺入会话其它视频素材
    const continuation = await this.resolveContinuationInput(script);
    const scriptMeta = script.meta ?? {};
    const scriptDuration =
      typeof scriptMeta.duration === 'number' && scriptMeta.duration > 0
        ? scriptMeta.duration
        : undefined;
    const scriptRatio =
      typeof scriptMeta.ratio === 'string' && scriptMeta.ratio
        ? scriptMeta.ratio
        : undefined;
    // 查询该会话下可作为生成参考的素材（达人形象照、环境照片、参考视频等）
    const referenceAssets = await this.assetRepo.find({
      where: {
        sessionId: script.sessionId,
        assetPurpose: In(['reference', 'all']),
      },
    });
    const videoUrls = fullVideoEdit
      ? [fullVideoEdit.sourceUrl]
      : continuation
        ? continuation.videoUrl
          ? [continuation.videoUrl]
          : []
        : referenceAssets
            .filter((a) => a.assetType === 'video')
            .map((a) => a.url);

    const userPrompt = options.userPrompt?.trim();
    const prompt = userPrompt
      ? `${script.seedancePrompt}\n\n## 本次生成补充要求\n${userPrompt}`
      : script.seedancePrompt;

    const finalImageUrls = continuation
      ? undefined
      : await this.resolveReferenceImageUrls(script, referenceAssets);
    const finalVideoUrls = [...new Set(videoUrls)];

    // 参考素材数量超官方上限属于用户侧问题，本地无法送达：直接中断并提示用户精简素材
    const imageCount = finalImageUrls?.length ?? 0;
    if (
      imageCount > ASSET_REF_LIMITS.image ||
      finalVideoUrls.length > ASSET_REF_LIMITS.video
    ) {
      throw new BadRequestException(
        `当前会话参考素材超出官方生成上限（图片 ${imageCount}/${ASSET_REF_LIMITS.image} 张、视频 ${finalVideoUrls.length}/${ASSET_REF_LIMITS.video} 个），请先移除多余素材后再生成。`,
      );
    }

    this.throwIfAborted(options.signal);
    const task = await this.createTask({
      sessionId: script.sessionId,
      userId: script.userId,
      scriptId: script.id,
      prompt,
      imageUrls: finalImageUrls,
      videoUrls: finalVideoUrls,
      firstFrameUrl: continuation?.lastFrameUrl,
      duration: fullVideoEdit?.sourceDurationSec ?? scriptDuration,
      ratio: fullVideoEdit?.ratio ?? scriptRatio,
      signal: options.signal,
    });
    this.throwIfAborted(options.signal);
    await this.markVideoGenerationStarted(script);
    this.throwIfAborted(options.signal);
    await this.saveTaskEventMessage(task, 'video_generation_submitted');
    return task;
  }

  /**
   * 创建分段任务：每段都带主角色人像/会话参考图，并按衔接方式叠加
   * 上一段成片或尾帧作为续接输入
   */
  private async createSegmentTask(
    script: VideoScript,
    segment: SegmentGenerationOptions,
    signal?: AbortSignal,
  ) {
    const prev = segment.prevTask ?? null;

    if (segment.segmentIndex > 1 && !prev) {
      throw new BadRequestException(
        `第 ${segment.segmentIndex} 段需要上一段任务作为续接输入`,
      );
    }

    let videoUrls: string[] | undefined;
    let firstFrameUrl: string | undefined;

    if (segment.segmentIndex === 1 && segment.continuation) {
      // 续写首段接着原片生成：延长模式只传原片成片，尾帧模式只传原片尾帧
      if (segment.continuityMode === 'frame_bridge') {
        if (!segment.continuation.lastFrameUrl) {
          throw new BadRequestException('原片尾帧不可用，无法作为本段首帧');
        }
        firstFrameUrl = segment.continuation.lastFrameUrl;
      } else if (segment.continuation.videoUrl) {
        videoUrls = [segment.continuation.videoUrl];
      }
    } else if (segment.continuityMode === 'frame_bridge') {
      if (!prev?.lastFrameUrl) {
        throw new BadRequestException('上一段尾帧尚未生成，无法作为本段首帧');
      }
      firstFrameUrl = prev.lastFrameUrl;
    } else if (segment.segmentIndex > 1) {
      if (!prev?.generatedVideoUrl) {
        throw new BadRequestException('上一段成片尚未生成完成，无法延长生成');
      }
      // 延长模式以上一段成片为底向后延长，同时仍带上参考图保持主体一致
      videoUrls = [prev.generatedVideoUrl];
    }

    // 每一段都带上主角色人像与会话参考图，跨段保持同一主体；
    // 首帧模式（frame_bridge）与参考图在接口层互斥，此时只能传首帧。
    let imageUrls: string[] | undefined;
    if (!firstFrameUrl) {
      const referenceAssets = await this.assetRepo.find({
        where: {
          sessionId: script.sessionId,
          assetPurpose: In(['reference', 'all']),
        },
      });
      const referenceImages = await this.resolveReferenceImageUrls(
        script,
        referenceAssets,
      );
      if (referenceImages.length > ASSET_REF_LIMITS.image) {
        throw new BadRequestException(
          `当前会话参考素材超出官方生成上限（图片 ${referenceImages.length}/${ASSET_REF_LIMITS.image} 张），请先移除多余素材后再生成。`,
        );
      }
      imageUrls = referenceImages.length > 0 ? referenceImages : undefined;
    }

    const scriptRatio =
      typeof script.meta?.ratio === 'string' && script.meta.ratio
        ? script.meta.ratio
        : '9:16';

    this.throwIfAborted(signal);
    const task = await this.createTask({
      sessionId: script.sessionId,
      userId: script.userId,
      scriptId: script.id,
      prompt: segment.prompt,
      imageUrls,
      videoUrls,
      firstFrameUrl,
      duration: segment.duration,
      ratio: scriptRatio,
      planId: segment.planId,
      segmentIndex: segment.segmentIndex,
      prevTaskId: prev?.taskId,
      continuityMode: segment.continuityMode,
      signal,
    });
    this.throwIfAborted(signal);
    await this.markVideoGenerationStarted(script);
    this.throwIfAborted(signal);
    await this.saveTaskEventMessage(task, 'video_generation_submitted');
    return task;
  }

  /**
   * 解析可传给视频模型的参考图：主角色人像 + 会话内参考/分析素材
   * （排除已由人像承载的 primaryAssetId，避免同一张图重复传参）。
   * 单次生成与分段生成的每一段都复用同一套规则，保证主体跨段一致。
   */
  private async resolveReferenceImageUrls(
    script: VideoScript,
    referenceAssets: VideoAsset[],
  ): Promise<string[]> {
    const characterImageUrl = await this.resolveCharacterImageUrl(script);
    const primaryAssetId = (script.meta?.character as CharacterMeta | undefined)
      ?.primaryAssetId;
    const imageUrls = referenceAssets
      .filter((a) => a.assetType === 'image')
      .filter(
        (a) => !Number.isInteger(primaryAssetId) || a.id !== primaryAssetId,
      )
      .map((a) => a.url);
    return [
      ...new Set([
        ...(characterImageUrl ? [characterImageUrl] : []),
        ...imageUrls,
      ]),
    ];
  }

  private async resolveCharacterImageUrl(
    script: VideoScript,
  ): Promise<string | null> {
    const character = script.meta?.character as CharacterMeta | undefined;
    if (!character || character.mode === 'none') {
      return null;
    }
    if (character.mode === 'preset_avatar') {
      if (
        !character.presetAvatarId ||
        !isPresetAvatarId(character.presetAvatarId)
      ) {
        throw new BadRequestException('脚本绑定的虚拟人像无效');
      }
      const avatar = getPresetAvatar(character.presetAvatarId);
      if (character.presetAlias && character.presetAlias !== avatar.alias) {
        throw new BadRequestException('脚本绑定的虚拟人像简称无效');
      }
      if (character.outfit) {
        const outfitValidation = validateAvatarOutfitSelection(
          avatar,
          character.outfit,
        );
        if (!outfitValidation.success) {
          throw new BadRequestException(outfitValidation.message);
        }
      }
      return `asset://${character.presetAvatarId}`;
    }
    if (!Number.isInteger(character.primaryAssetId)) {
      throw new BadRequestException('脚本未绑定有效的主角色人像素材');
    }
    const portraitAsset = await this.assetRepo.findOne({
      where: {
        id: character.primaryAssetId,
        sessionId: script.sessionId,
        userId: script.userId,
        assetType: 'image',
      },
    });
    if (!portraitAsset) {
      throw new BadRequestException('主角色人像素材不存在或无权访问');
    }
    return portraitAsset.url;
  }

  private async resolveFullVideoEdit(script: VideoScript): Promise<{
    sourceUrl: string;
    sourceDurationSec: number;
    ratio: string;
  } | null> {
    const edit = script.meta?.edit as FullVideoEditMeta | undefined;
    if (!edit || edit.mode !== 'full_video_edit') {
      return null;
    }

    if (
      !Number.isInteger(edit.sourceAssetId) ||
      !Number.isFinite(edit.sourceDurationSec) ||
      edit.sourceDurationSec <= 0 ||
      !Number.isFinite(edit.targetStartSec) ||
      !Number.isFinite(edit.targetEndSec) ||
      edit.targetStartSec < 0 ||
      edit.targetStartSec >= edit.targetEndSec ||
      edit.targetEndSec > edit.sourceDurationSec
    ) {
      throw new BadRequestException('完整视频编辑脚本的编辑参数无效');
    }

    const sourceAsset = await this.assetRepo.findOne({
      where: {
        id: edit.sourceAssetId,
        sessionId: script.sessionId,
        userId: script.userId,
        assetType: 'video',
      },
    });
    if (!sourceAsset) {
      throw new BadRequestException('完整视频编辑的原视频素材不存在或无权访问');
    }

    return {
      sourceUrl: sourceAsset.url,
      sourceDurationSec: edit.sourceDurationSec,
      ratio:
        typeof script.meta?.ratio === 'string' ? script.meta.ratio : '9:16',
    };
  }

  /**
   * 续写脚本的首段续接输入：延长模式取原片成片，尾帧模式取原片尾帧。
   * 尾帧只存在任务表，按原片成片 URL 反查最近的 succeeded 任务。
   * 非续写脚本返回 null。
   */
  async resolveContinuationInput(
    script: VideoScript,
    continuityMode?: VideoContinuityMode,
  ): Promise<{ videoUrl?: string; lastFrameUrl?: string } | null> {
    const continuation = script.meta?.continuation as
      | ContinuationMeta
      | undefined;
    if (!continuation || continuation.mode !== 'continuation') {
      return null;
    }
    if (
      !Number.isInteger(continuation.sourceAssetId) ||
      !Number.isFinite(continuation.sourceDurationSec) ||
      continuation.sourceDurationSec <= 0
    ) {
      throw new BadRequestException('续写脚本的原片参数无效');
    }

    const sourceAsset = await this.assetRepo.findOne({
      where: {
        id: continuation.sourceAssetId,
        sessionId: script.sessionId,
        userId: script.userId,
        assetType: 'video',
      },
    });
    if (!sourceAsset) {
      throw new BadRequestException('续写脚本的原片素材不存在或无权访问');
    }

    if ((continuityMode ?? continuation.continuityMode) === 'frame_bridge') {
      const prev = await this.videoTaskRepo.findOne({
        where: {
          sessionId: script.sessionId,
          generatedVideoUrl: sourceAsset.url,
          status: 'succeeded',
        },
        order: { createdAt: 'DESC' },
      });
      if (!prev?.lastFrameUrl) {
        throw new BadRequestException(
          '原片尾帧不可用，请改用「延长上一段」模式续写',
        );
      }
      return { lastFrameUrl: prev.lastFrameUrl };
    }

    return { videoUrl: sourceAsset.url };
  }

  /**
   * 查询任务状态（主动查询，兼容旧接口）
   */
  async queryTask(taskId: string, userId: number) {
    return this.videoTaskRepo.findOne({ where: { taskId, userId } });
  }

  /**
   * 取消或删除视频生成任务
   */
  async cancelOrDeleteTask(taskId: string, userId: number) {
    const task = await this.videoTaskRepo.findOne({
      where: { taskId, userId },
    });
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }

    if (task.status === 'running' || task.status === 'cancelled') {
      throw new Error(`任务状态为 ${task.status}，不支持取消/删除操作`);
    }

    const response = await fetch(`${this.apiUrl}/${taskId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`视频生成服务取消失败: HTTP ${response.status}`);
    }

    if (task.status === 'queued') {
      task.status = 'cancelled';
      await this.videoTaskRepo.save(task);
      await this.syncPlanProgress(task);
      await this.reconcileSessionStatus(task.sessionId);
      await this.saveTaskEventMessage(task, 'video_generation_result');
    } else {
      const planId = task.planId;
      await this.videoTaskRepo.remove(task);
      if (planId) {
        await this.recomputePlanProgress(planId, 'cancelled');
      }
      await this.reconcileSessionStatus(task.sessionId);
    }

    return { success: true };
  }

  /**
   * 分段计划作废某段时调用：尽力取消远端排队任务，并把本地任务置为已取消。
   * 已取消的任务是终态，后续到达的回调会被忽略。
   */
  async voidTask(task: VideoTask) {
    if (task.status === 'cancelled') return;

    if (task.status === 'queued') {
      try {
        await fetch(`${this.apiUrl}/${task.taskId}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
        });
      } catch (error) {
        this.logger.warn(
          `作废分段任务时远端取消失败: ${task.taskId}, ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    task.status = 'cancelled';
    await this.videoTaskRepo.save(task);
    await this.reconcileSessionStatus(task.sessionId);
    await this.saveTaskEventMessage(task, 'video_generation_result');
    await this.redis.publish(
      'video-task-updates',
      JSON.stringify({
        taskId: task.taskId,
        status: task.status,
        errorMessage: task.errorMessage,
      } satisfies TaskUpdatePayload),
    );
  }

  /**
   * 根据 sessionId 查询所有任务
   */
  async findBySessionId(sessionId: string, userId: number) {
    return this.videoTaskRepo.find({
      where: { sessionId, userId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * 火山引擎回调
   */
  async handleCallback(body: unknown) {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('回调内容必须是对象');
    }

    const data = body as Record<string, any>;
    const taskId = data.id;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new BadRequestException('回调缺少 task id');
    }
    if (
      typeof data.status !== 'string' ||
      !TASK_STATUSES.includes(data.status as (typeof TASK_STATUSES)[number])
    ) {
      throw new BadRequestException('回调任务状态无效');
    }

    const update = await this.applyTaskUpdate(taskId, data);
    if (!update.changed) {
      return { received: true, applied: false };
    }
    if (update.task?.status === 'persisting') {
      await this.taskQueue.add(
        'persist-generated-video',
        { taskId: update.task.taskId },
        {
          jobId: `persist-generated-video:${update.task.taskId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
        },
      );
    }
    if (update.task && TERMINAL_TASK_STATUSES.has(update.task.status)) {
      await this.reconcileSessionStatus(update.task.sessionId);
      await this.saveTaskEventMessage(update.task, 'video_generation_result');
    }

    const payload: TaskUpdatePayload = {
      taskId,
      status: update.task?.status ?? data.status,
      generatedVideoUrl: update.task?.generatedVideoUrl,
      errorMessage: update.task?.errorMessage,
    };

    await this.redis.publish('video-task-updates', JSON.stringify(payload));

    return { received: true, applied: true };
  }

  isValidCallbackToken(token?: string): boolean {
    const expectedToken = this.configService.get<string>(
      'VIDEO_CALLBACK_TOKEN',
    );
    if (!token || !expectedToken) {
      return false;
    }

    const tokenBuffer = Buffer.from(token);
    const expectedBuffer = Buffer.from(expectedToken);
    return (
      tokenBuffer.length === expectedBuffer.length &&
      timingSafeEqual(tokenBuffer, expectedBuffer)
    );
  }

  /**
   * SSE 订阅任务状态
   */
  subscribeTaskStatus(taskId: string, userId: number): Observable<any> {
    return new Observable((subscriber) => {
      if (!this.subscribers.has(taskId)) {
        this.subscribers.set(taskId, new Set());
      }
      this.subscribers.get(taskId)!.add(subscriber);

      this.videoTaskRepo.findOne({ where: { taskId, userId } }).then((task) => {
        if (task) {
          subscriber.next({
            data: {
              taskId,
              status: task.status,
              generatedVideoUrl: task.generatedVideoUrl,
              errorMessage: task.errorMessage,
            },
          });
          if (TERMINAL_TASK_STATUSES.has(task.status)) {
            subscriber.complete();
          }
        }
      });

      return () => {
        this.subscribers.get(taskId)?.delete(subscriber);
      };
    });
  }

  private getCallbackUrl(): string {
    const appBaseUrl = this.configService
      .get<string>('APP_BASE_URL')
      ?.replace(/\/+$/, '');
    const callbackToken = this.configService.get<string>(
      'VIDEO_CALLBACK_TOKEN',
    );
    if (!appBaseUrl || !callbackToken) {
      throw new Error(
        'APP_BASE_URL 和 VIDEO_CALLBACK_TOKEN 必须配置，才能创建视频任务',
      );
    }

    return `${appBaseUrl}/video/callback?token=${encodeURIComponent(callbackToken)}`;
  }

  private async markVideoGenerationStarted(script: VideoScript) {
    await this.scriptRepo.update(
      { id: script.id },
      { status: 'used_for_video' },
    );
    await this.sessionRepo.update(
      { sessionId: script.sessionId },
      { status: 'video_generating' },
    );
  }

  private async saveTaskEventMessage(
    task: VideoTask,
    eventType: 'video_generation_submitted' | 'video_generation_result',
  ) {
    const isSubmitted = eventType === 'video_generation_submitted';
    const isSucceeded = task.status === 'succeeded';
    const content = isSubmitted
      ? '视频生成任务已提交，正在处理中。'
      : isSucceeded
        ? '视频已生成，可以直接预览或下载。'
        : `视频生成未完成${task.errorMessage ? `：${task.errorMessage}` : '。'}`;
    const message = {
      sessionId: task.sessionId,
      userId: task.userId,
      role: 'assistant',
      content,
      parts: [{ type: 'text', text: content }],
      taskId: task.taskId,
      eventType,
      metadata: {
        kind: eventType,
        taskId: task.taskId,
        scriptId: task.scriptId,
        // 分段任务带计划 ID：前端据此在聊天流里隐藏卡片，只由分段面板展示结果
        planId: task.planId ?? null,
        status: task.status,
        generatedVideoUrl: task.generatedVideoUrl,
        errorMessage: task.errorMessage,
        duration: task.duration,
        ratio: task.ratio,
        resolution: task.resolution,
      },
    };

    // A task has one chat card. Later status events refresh its existing message.
    const existing = await this.messageRepo.findOne({
      where: { taskId: task.taskId },
    });
    if (existing) {
      // Retain the original event type so legacy duplicate rows cannot violate
      // the unique (taskId, eventType) index while being refreshed.
      if (
        existing.eventType === 'video_generation_submitted' ||
        existing.eventType === 'video_generation_result'
      ) {
        message.eventType = existing.eventType;
      }
      Object.assign(existing, message);
      await this.messageRepo.save(existing);
      return;
    }

    await this.messageRepo.save(this.messageRepo.create(message));
  }

  private async reconcileSessionStatus(sessionId: string) {
    const activeTaskCount = await this.videoTaskRepo.count({
      where: { sessionId, status: In(['queued', 'running', 'persisting']) },
    });
    if (activeTaskCount > 0) {
      await this.sessionRepo.update(
        { sessionId },
        { status: 'video_generating' },
      );
      return;
    }

    const succeededTaskCount = await this.videoTaskRepo.count({
      where: { sessionId, status: 'succeeded' },
    });
    await this.sessionRepo.update(
      { sessionId },
      {
        status: succeededTaskCount > 0 ? 'video_generated' : 'script_generated',
      },
    );
  }

  private async applyTaskUpdate(
    taskId: string,
    data: Record<string, any>,
  ): Promise<{ changed: boolean; task?: VideoTask }> {
    const task = await this.videoTaskRepo.findOne({ where: { taskId } });
    if (!task) {
      this.logger.warn(`回调任务不存在: ${taskId}`);
      return { changed: false };
    }

    const incomingStatus = data.status;
    if (task.status === 'persisting' && incomingStatus === 'succeeded') {
      return { changed: false };
    }
    if (
      TERMINAL_TASK_STATUSES.has(task.status) &&
      task.status !== incomingStatus
    ) {
      this.logger.warn(
        `忽略终态任务的回调: ${taskId}, ${task.status} -> ${incomingStatus}`,
      );
      return { changed: false };
    }

    const currentOrder = TASK_STATUS_ORDER[task.status] ?? 0;
    const incomingOrder = TASK_STATUS_ORDER[incomingStatus];
    if (incomingOrder < currentOrder) {
      this.logger.warn(
        `忽略乱序回调: ${taskId}, ${task.status} -> ${incomingStatus}`,
      );
      return { changed: false };
    }

    const response = JSON.stringify(data);
    if (task.status === incomingStatus && task.volcResponse === response) {
      return { changed: false };
    }

    task.status = incomingStatus;
    task.volcResponse = response;

    if (incomingStatus === 'succeeded' && data.content) {
      if (
        typeof data.content.video_url !== 'string' ||
        data.content.video_url.length === 0
      ) {
        throw new BadRequestException('回调缺少生成视频地址');
      }
      task.status = 'persisting';
      task.duration = data.duration;
      task.resolution = data.resolution;
      task.ratio = data.ratio;
    }

    if (incomingStatus === 'failed' && data.error) {
      task.errorCode = data.error.code;
      task.errorMessage = data.error.message;
    }

    await this.videoTaskRepo.save(task);
    if (
      task.planId &&
      (incomingStatus === 'failed' || incomingStatus === 'expired')
    ) {
      await this.syncPlanProgress(task);
    }
    return { changed: true, task };
  }

  /** 任务进入终态后同步所属分段计划的进度 */
  private async syncPlanProgress(task: VideoTask) {
    if (!task.planId) return;
    await this.recomputePlanProgress(task.planId, task.status);
  }

  private async recomputePlanProgress(planId: number, settledStatus: string) {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan || plan.status === 'cancelled') return;

    const succeeded = await this.videoTaskRepo.count({
      where: { planId, status: 'succeeded' },
    });
    plan.completedSegments = succeeded;

    if (succeeded >= plan.totalSegments) {
      plan.status = 'completed';
    } else if (settledStatus === 'failed' || settledStatus === 'expired') {
      plan.status = 'failed';
    } else if (settledStatus !== 'cancelled') {
      plan.status = 'awaiting_confirm';
    }

    await this.planRepo.save(plan);
  }

  async persistGeneratedVideo(taskId: string) {
    const task = await this.videoTaskRepo.findOne({ where: { taskId } });
    if (!task || task.status !== 'persisting') return;

    const response = JSON.parse(task.volcResponse || '{}');
    const content = response?.content;
    if (typeof content?.video_url !== 'string') {
      throw new Error('回调缺少可转存的视频地址');
    }

    const baseKey = `generated-videos/${task.sessionId}/${task.taskId}`;
    const video = await this.ossService.transferFromUrl(content.video_url, {
      ossKey: `${baseKey}/video.mp4`,
      fileName: `${task.taskId}.mp4`,
      allowedMimeTypes: ['video/mp4'],
      userId: task.userId,
    });
    const lastFrame =
      typeof content.last_frame_url === 'string'
        ? await this.ossService.transferFromUrl(content.last_frame_url, {
            ossKey: `${baseKey}/last-frame.jpg`,
            fileName: `${task.taskId}-last-frame.jpg`,
            allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
            userId: task.userId,
          })
        : null;

    task.generatedVideoUrl = video.url;
    task.lastFrameUrl = lastFrame?.url;
    task.status = 'succeeded';
    await this.videoTaskRepo.save(task);
    await this.syncPlanProgress(task);
    await this.reconcileSessionStatus(task.sessionId);
    await this.saveTaskEventMessage(task, 'video_generation_result');
    await this.redis.publish(
      'video-task-updates',
      JSON.stringify({
        taskId: task.taskId,
        status: task.status,
        generatedVideoUrl: task.generatedVideoUrl,
      } satisfies TaskUpdatePayload),
    );
  }

  async markVideoPersistenceFailed(taskId: string, error: unknown) {
    const task = await this.videoTaskRepo.findOne({ where: { taskId } });
    if (!task || task.status !== 'persisting') return;

    task.status = 'failed';
    task.errorCode = 'VIDEO_PERSIST_FAILED';
    task.errorMessage =
      error instanceof Error ? error.message : '视频保存到 OSS 失败';
    await this.videoTaskRepo.save(task);
    await this.syncPlanProgress(task);
    await this.reconcileSessionStatus(task.sessionId);
    await this.saveTaskEventMessage(task, 'video_generation_result');
    await this.redis.publish(
      'video-task-updates',
      JSON.stringify({
        taskId: task.taskId,
        status: task.status,
        errorMessage: task.errorMessage,
      } satisfies TaskUpdatePayload),
    );
  }

  /**
   * 查询火山引擎视频生成任务列表（远程）
   */
  async listRemoteTasks(params?: {
    pageNum?: number;
    pageSize?: number;
    status?: string;
    taskIds?: string[];
    model?: string;
  }) {
    const { pageNum = 1, pageSize = 20, status, taskIds, model } = params || {};

    const queryParts: string[] = [
      `page_num=${pageNum}`,
      `page_size=${pageSize}`,
    ];
    if (status) queryParts.push(`filter.status=${status}`);
    if (taskIds) {
      for (const id of taskIds) {
        queryParts.push(`filter.task_ids=${id}`);
      }
    }
    if (model) queryParts.push(`filter.model=${model}`);

    const url = `${this.apiUrl}?${queryParts.join('&')}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`视频生成服务查询失败: HTTP ${response.status}`);
    }

    return response.json();
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Video task request was aborted');
    }
  }
}
