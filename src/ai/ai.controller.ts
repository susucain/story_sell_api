import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Sse,
  Res,
} from '@nestjs/common';
import { AiService } from './ai.service';
import { Query } from '@nestjs/common';
import { from, map } from 'rxjs';
import { AiTtsStreamEvent, AI_TTS_STREAM_EVENT } from '../common/stream-events';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { pipeUIMessageStreamToResponse } from 'ai';
import { UIMessage } from 'ai';

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Get('chat')
  async chat(@Query('query') query: string) {
    const answer = await this.aiService.runChain(query);
    return { answer };
  }

  @Sse('chat/stream')
  async streamChat(
    @Query('query') query: string,
    @Query('ttsSessionId') ttsSessionId?: string,
  ) {
    const sessionId = ttsSessionId?.trim?.();

    // 发送开始事件(请求开始时连接websocket)
    if (sessionId) {
      const startEvent: AiTtsStreamEvent = { type: 'start', sessionId, query };
      this.eventEmitter.emit(AI_TTS_STREAM_EVENT, startEvent);
    }
    return from(this.aiService.streamChain(query, sessionId)).pipe(
      map((chunk) => ({ data: chunk })),
    );
  }

  @Get('chat/tool')
  async chatWithTool(@Query('query') query: string) {
    const answer = await this.aiService.runChainWithTool(query);
    return { answer };
  }

  @Sse('chat/tool/stream')
  async streamChatWithTool(@Query('query') query: string) {
    return from(this.aiService.runChainWithToolStream(query)).pipe(
      map((chunk) => ({ data: chunk })),
    );
  }

  @Post('chat')
  async agentChat(
    @Body() body: { messages: UIMessage[] },
    @Res() res: Response,
  ) {
    if (!body.messages || !Array.isArray(body.messages)) {
      throw new Error('Invalid JSON');
    }

    const stream = await this.aiService.agentStream(body.messages);

    // sdk 会自动处理响应，将响应转换为sse格式
    pipeUIMessageStreamToResponse({ response: res as any, stream });
  }
}
