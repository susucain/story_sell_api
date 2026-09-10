import { BadRequestException, Controller, Post, Get, Delete, Patch, Body, Res, Param, Query, Sse, UnauthorizedException } from '@nestjs/common';
import { VideoService } from './video.service';
import { VideoTaskService } from './video-task.service';
import { pipeUIMessageStreamToResponse } from 'ai';
import { UIMessage } from 'ai';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';

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
      user_id?: number;
    },
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
      userId: body.user_id,
    });
    pipeUIMessageStreamToResponse({ response: res as any, stream });
  }

  @Get('history/:sessionId')
  async getHistory(@Param('sessionId') sessionId: string) {
    return this.videoService.findHistoryBySessionId(sessionId);
  }

  @Post('assets')
  async createAsset(
    @Body() body: {
      session_id: string;
      user_id?: number;
      asset_type: 'image' | 'video' | 'url';
      asset_purpose?: 'all' | 'analysis' | 'reference';
      name: string;
      url: string;
      thumbnail_url?: string;
      duration_sec?: number;
      content_category?: 'portrait' | 'product' | 'food' | 'store' | 'environment' | 'other';
    },
  ) {
    return this.videoService.createAsset(body);
  }

  @Get('assets/:sessionId')
  async getAssets(@Param('sessionId') sessionId: string) {
    return this.videoService.findAssetsBySessionId(sessionId);
  }

  @Delete('assets/:assetId')
  async deleteAsset(@Param('assetId') assetId: number) {
    return this.videoService.deleteAsset(assetId);
  }

  @Patch('assets/:assetId')
  async updateAssetPurpose(
    @Param('assetId') assetId: number,
    @Body() body: { asset_purpose: 'all' | 'analysis' | 'reference' },
  ) {
    if (!['all', 'analysis', 'reference'].includes(body.asset_purpose)) {
      throw new BadRequestException('asset_purpose 必须为 all、analysis 或 reference');
    }
    return this.videoService.updateAssetPurpose(assetId, body.asset_purpose);
  }

  @Get('scripts/:sessionId')
  async getScripts(@Param('sessionId') sessionId: string) {
    return this.videoService.findScriptsBySessionId(sessionId);
  }

  @Get('scripts/:scriptId/detail')
  async getScriptDetail(@Param('scriptId') scriptId: number) {
    return this.videoService.findScriptById(scriptId);
  }

  @Post('generate')
  async generateVideo(
    @Body() body: {
      script_id: number;
      session_id?: string;
      user_id?: number;
      user_prompt?: string;
      assets?: Array<{
        type: 'image' | 'video';
        url: string;
        name?: string;
      }>;
    },
  ) {
    return this.videoTaskService.createTaskByScriptId(body.script_id, {
      sessionId: body.session_id,
      userId: body.user_id,
      userPrompt: body.user_prompt,
      assets: body.assets,
    });
  }

  @Get('generate/:taskId')
  async getVideoTask(@Param('taskId') taskId: string) {
    return this.videoTaskService.queryTask(taskId);
  }

  @Get('generate/:taskId/stream')
  @Sse()
  streamTaskStatus(@Param('taskId') taskId: string): Observable<any> {
    return this.videoTaskService.subscribeTaskStatus(taskId);
  }

  @Delete('generate/:taskId')
  async cancelOrDeleteVideoTask(@Param('taskId') taskId: string) {
    return this.videoTaskService.cancelOrDeleteTask(taskId);
  }

  @Get('generate/list/:sessionId')
  async getVideoTaskList(@Param('sessionId') sessionId: string) {
    return this.videoTaskService.findBySessionId(sessionId);
  }

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
    @Query('user_id') userId?: number,
    @Query('page') page?: number,
    @Query('page_size') pageSize?: number,
    @Query('keyword') keyword?: string,
  ) {
    const normalizedKeyword =
      typeof keyword === 'string' ? keyword.trim() : undefined;
    if (normalizedKeyword && normalizedKeyword.length > 64) {
      throw new BadRequestException('搜索关键词不能超过 64 个字符');
    }

    return this.videoService.findSessionsByUserId(userId ? Number(userId) : 1, {
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 7,
      keyword: normalizedKeyword,
    });
  }

  @Get('tasks/remote')
  async getRemoteTaskList(
    @Query('page_num') pageNum?: number,
    @Query('page_size') pageSize?: number,
    @Query('status') status?: string,
    @Query('model') model?: string,
  ) {
    return this.videoTaskService.listRemoteTasks({
      pageNum: pageNum ? Number(pageNum) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status,
      model,
    });
  }
}
