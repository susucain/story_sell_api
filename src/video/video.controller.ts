import { BadRequestException, Controller, Post, Get, Delete, Patch, Body, Res, Param, Query, Sse, UnauthorizedException } from '@nestjs/common';
import { VideoService } from './video.service';
import { VideoTaskService } from './video-task.service';
import { pipeUIMessageStreamToResponse } from 'ai';
import { UIMessage } from 'ai';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

@Controller('video')
export class VideoController {
  constructor(
    private readonly videoService: VideoService,
    private readonly videoTaskService: VideoTaskService,
  ) { }

  @Post('chat')
  async chat(
    @Body() body: {
      messages: UIMessage[];
      session_id?: string;
      referenced_script_id?: number;
      source_video_asset_id?: number;
    },
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    if (!body.messages || !Array.isArray(body.messages)) {
      throw new Error('Invalid messages format');
    }

    for (const msg of body.messages) {
      if (!msg.parts || !Array.isArray(msg.parts)) {
        throw new Error(`Invalid message format: message must have 'parts' array. Got: ${JSON.stringify(msg)}`);
      }
    }

    const sessionId = body.session_id ?? randomUUID();
    const latestMessage = body.messages[body.messages.length - 1];
    const stream = await this.videoService.streamChat(sessionId, latestMessage ? [latestMessage] : [], {
      referencedScriptId: body.referenced_script_id,
      sourceVideoAssetId: body.source_video_asset_id,
      userId: user.id,
    });
    pipeUIMessageStreamToResponse({ response: res as any, stream });
  }

  @Get('history/:sessionId')
  async getHistory(@Param('sessionId') sessionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.videoService.findHistoryBySessionId(sessionId, user.id);
  }

  @Post('assets')
  async createAsset(
    @Body() body: {
      session_id: string;
      asset_type: 'image' | 'video' | 'url';
      asset_purpose?: 'all' | 'analysis' | 'reference';
      name: string;
      url: string;
      thumbnail_url?: string;
      duration_sec?: number;
      content_category?: 'portrait' | 'product' | 'food' | 'store' | 'environment' | 'other';
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoService.createAsset(body, user.id);
  }

  @Get('assets/:sessionId')
  async getAssets(@Param('sessionId') sessionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.videoService.findAssetsBySessionId(sessionId, user.id);
  }

  @Delete('assets/:assetId')
  async deleteAsset(@Param('assetId') assetId: number, @CurrentUser() user: AuthenticatedUser) {
    return this.videoService.deleteAsset(assetId, user.id);
  }

  @Patch('assets/:assetId')
  async updateAssetPurpose(
    @Param('assetId') assetId: number,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { asset_purpose: 'all' | 'analysis' | 'reference' },
  ) {
    if (!['all', 'analysis', 'reference'].includes(body.asset_purpose)) {
      throw new BadRequestException('asset_purpose 必须为 all、analysis 或 reference');
    }
    return this.videoService.updateAssetPurpose(assetId, user.id, body.asset_purpose);
  }

  @Get('scripts/:sessionId')
  async getScripts(@Param('sessionId') sessionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.videoService.findScriptsBySessionId(sessionId, user.id);
  }

  @Get('scripts/:scriptId/detail')
  async getScriptDetail(@Param('scriptId') scriptId: number, @CurrentUser() user: AuthenticatedUser) {
    return this.videoService.findScriptById(scriptId, user.id);
  }

  @Post('generate')
  async generateVideo(
    @Body() body: {
      script_id: number;
      session_id?: string;
      user_prompt?: string;
      assets?: Array<{
        type: 'image' | 'video';
        url: string;
        name?: string;
      }>;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoTaskService.createTaskByScriptId(body.script_id, {
      sessionId: body.session_id,
      userId: user.id,
      userPrompt: body.user_prompt,
      assets: body.assets,
    });
  }

  @Get('generate/:taskId')
  async getVideoTask(@Param('taskId') taskId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.videoTaskService.queryTask(taskId, user.id);
  }

  @Get('generate/:taskId/stream')
  @Sse()
  streamTaskStatus(@Param('taskId') taskId: string, @CurrentUser() user: AuthenticatedUser): Observable<any> {
    return this.videoTaskService.subscribeTaskStatus(taskId, user.id);
  }

  @Delete('generate/:taskId')
  async cancelOrDeleteVideoTask(@Param('taskId') taskId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.videoTaskService.cancelOrDeleteTask(taskId, user.id);
  }

  @Get('generate/list/:sessionId')
  async getVideoTaskList(@Param('sessionId') sessionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.videoTaskService.findBySessionId(sessionId, user.id);
  }

  @Public()
  @Post('callback')
  async handleCallback(
    @Body() body: any,
    @Query('token') token?: string,
  ) {
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
