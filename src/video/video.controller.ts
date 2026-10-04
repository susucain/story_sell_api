import {
  BadRequestException,
  Controller,
  Post,
  Get,
  Delete,
  Patch,
  Body,
  Req,
  Res,
  Param,
  ParseIntPipe,
  Query,
  Sse,
  UnauthorizedException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { VideoService } from './video.service';
import { VideoTaskService } from './video-task.service';
import { VideoGenerationPlanService } from './video-generation-plan.service';
import { AgentRunService } from './agent-run.service';
import { RunEventService } from './run-event.service';
import type { RunEvent } from './run-event.service';
import type { VideoContinuityMode } from './entities/video-generation-plan.entity';
import { pipeUIMessageStreamToResponse } from 'ai';
import { UIMessage } from 'ai';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  VideoAgentTimeoutError,
  VideoAgentTimeoutCode,
} from './video-agent-execution.service';

export interface VideoAgentClientError {
  code:
    | VideoAgentTimeoutCode
    | 'OPERATION_STATUS_UNKNOWN'
    | 'VIDEO_AGENT_ERROR';
  retryable: boolean;
  message: string;
}

export function toVideoAgentError(error: unknown): VideoAgentClientError {
  if (error instanceof VideoAgentTimeoutError) {
    if (error.sideEffectStarted) {
      return {
        code: 'OPERATION_STATUS_UNKNOWN',
        retryable: false,
        message: '操作状态未知，请刷新查看结果',
      };
    }
    return {
      code: error.code,
      retryable: true,
      message: '创作请求超时，请重试',
    };
  }

  return {
    code: 'VIDEO_AGENT_ERROR',
    retryable: false,
    message: '创作过程中出现错误，请稍后重试',
  };
}

/** 把执行期错误映射成用于 run 收尾的错误码 */
function resolveRunErrorCode(error: unknown): string {
  return error instanceof VideoAgentTimeoutError
    ? error.code
    : 'VIDEO_AGENT_ERROR';
}

/** 以 SSE 帧格式写出一条 run 事件（`id:` 作为重放游标） */
function writeRunEvent(res: Response, event: RunEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

@Controller('video')
export class VideoController {
  private readonly logger = new Logger(VideoController.name);

  constructor(
    private readonly videoService: VideoService,
    private readonly videoTaskService: VideoTaskService,
    private readonly videoGenerationPlanService: VideoGenerationPlanService,
    private readonly agentRunService: AgentRunService,
    private readonly runEventService: RunEventService,
  ) {}

  @Post('chat')
  async chat(
    @Body()
    body: {
      messages: UIMessage[];
      session_id?: string;
      referenced_script_id?: number;
      source_video_asset_id?: number;
      /** 引用视频的意图，缺省按编辑原片处理；continue 表示基于原片续写新剧情 */
      source_video_intent?: 'edit' | 'continue';
      /** 仅续写时有意义：首段与原片的衔接方式 */
      continuity_mode?: 'extend' | 'frame_bridge';
      retry?: boolean;
    },
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!body.messages || !Array.isArray(body.messages)) {
      throw new Error('Invalid messages format');
    }

    for (const msg of body.messages) {
      if (!msg.parts || !Array.isArray(msg.parts)) {
        throw new Error('Invalid message format');
      }
    }

    const sessionId = body.session_id ?? randomUUID();
    const latestMessage = body.messages[body.messages.length - 1];

    // 先开一条运行：同会话已有进行中的链路时直接 409，
    // 避免两条链路并发写同一份会话状态。
    const run = await this.agentRunService.startRun(sessionId, user.id);

    // 中止信号的主人是 run，而不是这次 HTTP 请求。
    // Phase 2 起：客户端断开（刷新/切会话/断网）只表示「不再订阅」，
    // 不再中止 run；run 会继续执行并把事件写入日志，供重连后重放。
    // 唯一的中止来源是显式取消（POST /video/chat/cancel）或超时回收。
    const cleanupDisconnectListeners = () => {
      req.removeListener('aborted', onRequestAborted);
      res.removeListener('close', onResponseClose);
      res.removeListener('finish', cleanupDisconnectListeners);
    };
    const onRequestAborted = () => {
      this.logger.log(
        JSON.stringify({
          event: 'run_subscription_detached',
          reason: 'request_aborted',
          runId: run.runId,
          sessionId,
        }),
      );
      cleanupDisconnectListeners();
    };
    const onResponseClose = () => {
      if (!res.writableEnded) {
        this.logger.log(
          JSON.stringify({
            event: 'run_subscription_detached',
            reason: 'response_closed',
            runId: run.runId,
            sessionId,
          }),
        );
      }
      cleanupDisconnectListeners();
    };
    req.once('aborted', onRequestAborted);
    res.once('close', onResponseClose);
    res.once('finish', cleanupDisconnectListeners);
    // 客户端断开后仍可能有数据落到已销毁的响应上；兜住以免升级为未捕获异常
    res.on('error', (error: Error) => {
      this.logger.warn(`SSE 响应写入失败: ${error.message}`);
    });

    let stream: Awaited<ReturnType<VideoService['streamChat']>>;
    try {
      stream = await this.videoService.streamChat(
        sessionId,
        latestMessage ? [latestMessage] : [],
        {
          referencedScriptId: body.referenced_script_id,
          sourceVideoAssetId: body.source_video_asset_id,
          sourceVideoIntent: body.source_video_intent,
          continuityMode: body.continuity_mode,
          userId: user.id,
          requestId:
            typeof res.locals.requestId === 'string'
              ? res.locals.requestId
              : randomUUID(),
          onError: (error) => {
            this.agentRunService.markError(run, resolveRunErrorCode(error));
            return JSON.stringify(toVideoAgentError(error));
          },
          retry: body.retry === true,
          parentSignal: run.controller.signal,
          runId: run.runId,
        },
      );
    } catch (error: unknown) {
      // 起流失败也要收尾，否则会话会被永久判定为「进行中」
      cleanupDisconnectListeners();
      this.agentRunService.markError(run, resolveRunErrorCode(error));
      await this.agentRunService.finalize(run);
      throw error;
    }

    // 录制一份可重放的事件日志（面板/正文/结果），供刷新后恢复订阅
    const recordedStream = this.runEventService.recordStream(run.runId, stream);

    void pipeUIMessageStreamToResponse({
      response: res,
      stream: recordedStream,
      // 独立消费一份 SSE 流：run 的推进与收尾不依赖客户端那一路
      consumeSseStream: ({ stream: sseStream }) => {
        void this.agentRunService.watchStream(run, sseStream);
      },
    }).catch((error: unknown) => {
      this.logger.warn(
        `SSE 管道结束异常（run 收尾由 watchStream 负责）: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  /**
   * 取消某会话进行中的链路。
   * 产品约定：一个会话同一时刻只有一条链路，所以按 session_id 定位。
   */
  @Post('chat/cancel')
  async cancelChat(
    @Body() body: { session_id?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body?.session_id) {
      throw new BadRequestException('session_id 不能为空');
    }
    const cancelled = await this.agentRunService.cancel(
      body.session_id,
      user.id,
    );
    return { cancelled };
  }

  /**
   * 查询会话当前进行中的 run。无在途运行时返回 `{ run: null }`，
   * 前端据此决定是否挂载「恢复视图」。
   */
  @Get('sessions/:sessionId/active-run')
  async getActiveRun(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // 读 DB 而非进程内注册表，负载均衡下任意实例都能正确回答
    const run = await this.agentRunService.findRunningBySession(sessionId);
    if (!run || run.userId !== user.id) {
      return { run: null };
    }
    return {
      run: {
        runId: run.runId,
        status: 'running' as const,
        startedAt: run.startedAt.toISOString(),
      },
    };
  }

  /**
   * 订阅 run 的事件流：先重放 `after` 之后的事件，再尾随推送。
   * `id:` 为事件游标，客户端断开重连时带上 `after` 即可无缝续上。
   */
  @Get('runs/:runId/events')
  async streamRunEvents(
    @Param('runId') runId: string,
    @Query('after') after: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const run = await this.agentRunService.findByRunId(runId);
    if (!run || run.userId !== user.id) {
      throw new NotFoundException('运行不存在');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const controller = new AbortController();
    // 阻塞读用独立连接，且断开时直接关掉它：既避免读写互相堵死，
    // 也能真正中断在途的 XREAD（AbortSignal 取消不了已发出的阻塞命令）。
    const tailClient = this.runEventService.createTailClient();
    const onClose = () => {
      controller.abort();
      tailClient.disconnect();
    };
    req.once('aborted', onClose);
    res.once('close', onClose);
    res.on('error', (error: Error) => {
      this.logger.warn(`run 事件流写入失败: ${error.message}`);
      onClose();
    });

    let cursor = typeof after === 'string' && after !== '0' ? after : undefined;
    try {
      const replayed = await this.runEventService.readAfter(runId, cursor);
      for (const event of replayed) {
        if (controller.signal.aborted) return;
        cursor = event.id;
        writeRunEvent(res, event);
        if (event.type === 'done') {
          res.end();
          return;
        }
      }

      let tailFrom = cursor ?? '0-0';
      while (!controller.signal.aborted) {
        const events = await this.runEventService.readAfterBlocking(
          runId,
          tailFrom,
          25_000,
          tailClient,
        );
        if (controller.signal.aborted) return;
        if (!events) {
          // 心跳注释，避免中间代理按空闲超时断开
          res.write(': ping\n\n');
          continue;
        }
        for (const event of events) {
          tailFrom = event.id;
          writeRunEvent(res, event);
          if (event.type === 'done') {
            res.end();
            return;
          }
        }
      }
    } catch (error: unknown) {
      // 断开导致的连接关闭属正常收尾，不当作异常噪音
      if (!controller.signal.aborted) {
        this.logger.warn(
          `run 事件流结束: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      req.removeListener('aborted', onClose);
      res.removeListener('close', onClose);
      tailClient.disconnect();
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  @Get('history/:sessionId')
  async getHistory(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoService.findHistoryBySessionId(sessionId, user.id);
  }

  @Post('assets')
  async createAsset(
    @Body()
    body: {
      session_id: string;
      asset_type: 'image' | 'video' | 'url';
      asset_purpose?: 'all' | 'analysis' | 'reference';
      name: string;
      url: string;
      thumbnail_url?: string;
      duration_sec?: number;
      content_category?:
        | 'portrait'
        | 'product'
        | 'food'
        | 'store'
        | 'environment'
        | 'other';
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoService.createAsset(body, user.id);
  }

  @Get('assets/:sessionId')
  async getAssets(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoService.findAssetsBySessionId(sessionId, user.id);
  }

  @Delete('assets/:assetId')
  async deleteAsset(
    @Param('assetId') assetId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoService.deleteAsset(assetId, user.id);
  }

  @Patch('assets/:assetId')
  async updateAssetPurpose(
    @Param('assetId') assetId: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { asset_purpose: 'all' | 'analysis' | 'reference' },
  ) {
    if (!['all', 'analysis', 'reference'].includes(body.asset_purpose)) {
      throw new BadRequestException(
        'asset_purpose 必须为 all、analysis 或 reference',
      );
    }
    return this.videoService.updateAssetPurpose(
      assetId,
      user.id,
      body.asset_purpose,
    );
  }

  @Get('scripts/:sessionId')
  async getScripts(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoService.findScriptsBySessionId(sessionId, user.id);
  }

  @Get('scripts/:scriptId/detail')
  async getScriptDetail(
    @Param('scriptId') scriptId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoService.findScriptById(scriptId, user.id);
  }

  @Post('generate')
  async generateVideo(
    @Body()
    body: {
      script_id: number;
      session_id?: string;
      user_prompt?: string;
      mode?: 'single' | 'segmented';
      assets?: Array<{
        type: 'image' | 'video';
        url: string;
        name?: string;
      }>;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (body.mode === 'segmented') {
      return this.videoGenerationPlanService.createPlan(body.script_id, {
        sessionId: body.session_id,
        userId: user.id,
        userPrompt: body.user_prompt,
        assets: body.assets,
      });
    }

    return this.videoTaskService.createTaskByScriptId(body.script_id, {
      sessionId: body.session_id,
      userId: user.id,
      userPrompt: body.user_prompt,
      assets: body.assets,
    });
  }

  // 必须声明在 generate/:taskId 之前，否则会被动态参数路由抢先匹配
  @Get('generate/plan/:planId')
  async getGenerationPlan(
    @Param('planId', ParseIntPipe) planId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoGenerationPlanService.getPlan(planId, user.id);
  }

  @Post('generate/plan/:planId/next')
  async generateNextSegment(
    @Param('planId', ParseIntPipe) planId: number,
    @Body() body: { continuity_mode?: VideoContinuityMode },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoGenerationPlanService.startNextSegment(
      planId,
      body.continuity_mode ?? 'extend',
      user.id,
    );
  }

  @Post('generate/plan/:planId/segments/:segmentIndex/regenerate')
  async regenerateSegment(
    @Param('planId', ParseIntPipe) planId: number,
    @Param('segmentIndex', ParseIntPipe) segmentIndex: number,
    @Body() body: { continuity_mode?: VideoContinuityMode },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoGenerationPlanService.regenerateSegment(
      planId,
      segmentIndex,
      body.continuity_mode ?? 'extend',
      user.id,
    );
  }

  @Post('generate/plan/:planId/cancel')
  async cancelGenerationPlan(
    @Param('planId', ParseIntPipe) planId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoGenerationPlanService.cancelPlan(planId, user.id);
  }

  // 必须声明在 generate/:taskId 之前，否则会被动态参数路由抢先匹配
  @Get('generate/remote/list')
  async listRemoteVideoTasks(
    @Query('page_num') pageNum?: string,
    @Query('page_size') pageSize?: string,
    @Query('status') status?: string,
    @Query('task_ids') taskIds?: string | string[],
    @Query('model') model?: string,
  ) {
    const normalizedTaskIds = Array.isArray(taskIds)
      ? taskIds
      : taskIds
        ? [taskIds]
        : undefined;

    return this.videoTaskService.listRemoteTasks({
      pageNum: pageNum ? Number(pageNum) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status,
      taskIds: normalizedTaskIds,
      model,
    });
  }

  @Get('generate/:taskId')
  async getVideoTask(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoTaskService.queryTask(taskId, user.id);
  }

  @Get('generate/:taskId/stream')
  @Sse()
  streamTaskStatus(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Observable<any> {
    return this.videoTaskService.subscribeTaskStatus(taskId, user.id);
  }

  @Delete('generate/:taskId')
  async cancelOrDeleteVideoTask(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoTaskService.cancelOrDeleteTask(taskId, user.id);
  }

  @Get('generate/list/:sessionId')
  async getVideoTaskList(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoTaskService.findBySessionId(sessionId, user.id);
  }

  @Public()
  @Post('callback')
  async handleCallback(@Body() body: any, @Query('token') token?: string) {
    if (!this.videoTaskService.isValidCallbackToken(token)) {
      throw new UnauthorizedException('无效的回调来源');
    }

    return this.videoTaskService.handleCallback(body);
  }

  @Get('sessions')
  async getSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') page?: number,
    @Query('page_size') pageSize?: number,
    @Query('keyword') keyword?: string,
  ) {
    const normalizedKeyword =
      typeof keyword === 'string' ? keyword.trim() : undefined;
    if (normalizedKeyword && normalizedKeyword.length > 64) {
      throw new BadRequestException('搜索关键词不能超过 64 个字符');
    }

    return this.videoService.findSessionsByUserId(user.id, {
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 7,
      keyword: normalizedKeyword,
    });
  }
}
