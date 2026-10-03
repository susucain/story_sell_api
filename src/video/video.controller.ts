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
} from '@nestjs/common';
import { VideoService } from './video.service';
import { VideoTaskService } from './video-task.service';
import { VideoGenerationPlanService } from './video-generation-plan.service';
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

@Controller('video')
export class VideoController {
  constructor(
    private readonly videoService: VideoService,
    private readonly videoTaskService: VideoTaskService,
    private readonly videoGenerationPlanService: VideoGenerationPlanService,
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

    const disconnectController = new AbortController();
    const abortForDisconnect = () => {
      if (!disconnectController.signal.aborted) {
        disconnectController.abort(new Error('Video chat client disconnected'));
      }
    };
    const cleanupDisconnectListeners = () => {
      req.removeListener('aborted', onRequestAborted);
      res.removeListener('close', onResponseClose);
      res.removeListener('finish', cleanupDisconnectListeners);
    };
    const onRequestAborted = () => {
      abortForDisconnect();
      cleanupDisconnectListeners();
    };
    const onResponseClose = () => {
      if (!res.writableEnded) {
        abortForDisconnect();
      }
      cleanupDisconnectListeners();
    };
    req.once('aborted', onRequestAborted);
    res.once('close', onResponseClose);
    res.once('finish', cleanupDisconnectListeners);

    const sessionId = body.session_id ?? randomUUID();
    const latestMessage = body.messages[body.messages.length - 1];
    const stream = await this.videoService.streamChat(
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
        onError: (error) => JSON.stringify(toVideoAgentError(error)),
        retry: body.retry === true,
        parentSignal: disconnectController.signal,
      },
    );
    void pipeUIMessageStreamToResponse({ response: res, stream });
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
