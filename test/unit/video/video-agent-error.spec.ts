jest.mock('ai', () => ({
  ToolLoopAgent: class {},
  createUIMessageStream: jest.fn(),
  pipeUIMessageStreamToResponse: jest.fn(),
  convertToModelMessages: jest.fn().mockResolvedValue([]),
  getToolName: jest.fn(),
  isStepCount: jest.fn(),
  isToolUIPart: jest.fn(),
  tool: jest.fn((definition) => definition),
  zodSchema: jest.fn((schema) => schema),
}));

jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(),
}));

import { createUIMessageStream } from 'ai';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toVideoAgentError } from '../../../src/video/video.controller';
import { VideoController } from '../../../src/video/video.controller';
import {
  VideoAgentExecutionService,
  VideoAgentTimeoutError,
} from '../../../src/video/video-agent-execution.service';
import { VideoService } from '../../../src/video/video.service';
import { VideoToolsService } from '../../../src/video/video-tools.service';

const mockedCreateUIMessageStream =
  createUIMessageStream as jest.MockedFunction<typeof createUIMessageStream>;

describe('video agent stream errors', () => {
  it('passes a client disconnect signal to chat work but ignores a normally finished response close', async () => {
    const streamChat = jest.fn().mockResolvedValue(new ReadableStream());
    const controller = new VideoController(
      { streamChat } as any,
      {} as any,
    );
    const request = new EventEmitter() as any;
    const response = Object.assign(new EventEmitter(), {
      locals: { requestId: 'request-1' },
      writableEnded: false,
    }) as any;

    await (controller as any).chat(
      { messages: [uiUserMessage('user-1')] },
      { id: 7 },
      request,
      response,
    );

    const parentSignal = streamChat.mock.calls[0][2].parentSignal as AbortSignal;
    request.emit('aborted');
    expect(parentSignal.aborted).toBe(true);

    const finishedRequest = new EventEmitter() as any;
    const finishedResponse = Object.assign(new EventEmitter(), {
      locals: { requestId: 'request-2' },
      writableEnded: true,
    }) as any;
    await (controller as any).chat(
      { messages: [uiUserMessage('user-2')] },
      { id: 7 },
      finishedRequest,
      finishedResponse,
    );

    const finishedSignal = streamChat.mock.calls[1][2]
      .parentSignal as AbortSignal;
    finishedResponse.emit('close');
    expect(finishedSignal.aborted).toBe(false);
  });

  it('does not configure video telemetry or error logs with raw model content', async () => {
    const source = await fs.readFile(
      path.resolve(__dirname, '../../../src/video/video.service.ts'),
      'utf8',
    );

    expect(source).not.toContain('langfuse.trace.input');
    expect(source).toContain('recordInputs: false');
    expect(source).toContain('recordOutputs: false');
    expect(source).not.toContain('err.message');
    expect(source).not.toContain('err.stack');
  });

  it('serializes typed timeouts without provider details', () => {
    const error = toVideoAgentError(
      new VideoAgentTimeoutError('AGENT_TOTAL_TIMEOUT', 'agent_total', 300000),
    );

    expect(error).toEqual({
      code: 'AGENT_TOTAL_TIMEOUT',
      retryable: true,
      message: '创作请求超时，请重试',
    });
    expect(JSON.stringify(error)).not.toContain('agent_total');
  });

  it('serializes a timeout after script persistence begins as a non-retryable status-unknown outcome', () => {
    const timeout = Object.assign(
      new VideoAgentTimeoutError('TOOL_TIMEOUT', 'script_save', 45000),
      {
        toolName: 'generate_script',
        sideEffectStarted: true,
      },
    );

    expect(toVideoAgentError(timeout)).toEqual({
      code: 'OPERATION_STATUS_UNKNOWN',
      retryable: false,
      message: '操作状态未知，请刷新查看结果',
    });
  });

  it('serializes a timeout after video-task submission begins as a non-retryable status-unknown outcome', () => {
    const timeout = Object.assign(
      new VideoAgentTimeoutError('TOOL_TIMEOUT', 'tool', 30000),
      {
        toolName: 'create_video_task',
        sideEffectStarted: true,
      },
    );

    expect(toVideoAgentError(timeout)).toEqual({
      code: 'OPERATION_STATUS_UNKNOWN',
      retryable: false,
      message: '操作状态未知，请刷新查看结果',
    });
  });

  it('keeps a total timeout before a mutation retryable', () => {
    const timeout = Object.assign(
      new VideoAgentTimeoutError('AGENT_TOTAL_TIMEOUT', 'agent_total', 300000),
      {
        toolName: 'create_video_task',
        sideEffectStarted: false,
      },
    );

    expect(toVideoAgentError(timeout)).toEqual({
      code: 'AGENT_TOTAL_TIMEOUT',
      retryable: true,
      message: '创作请求超时，请重试',
    });
  });

  it('serializes a total timeout after generate_script starts persistence as status unknown', async () => {
    jest.useFakeTimers();
    const previousTotalTimeout = process.env.VIDEO_AGENT_TOTAL_TIMEOUT_MS;
    const previousScriptTimeout = process.env.VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS;
    process.env.VIDEO_AGENT_TOTAL_TIMEOUT_MS = '5';
    process.env.VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS = '100';

    try {
      const executionService = new VideoAgentExecutionService(
        new ConfigService(),
      );
      const mutationState = { sideEffectStarted: false };
      const scriptRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((value) => value),
        save: jest.fn(() => new Promise(() => undefined)),
      };
      const tools = new (VideoToolsService as any)(
        {},
        scriptRepo,
        { update: jest.fn() },
        {},
        {
          parse: jest.fn(() => ({
            hook: '商品介绍',
            shots: [{ shot: 1 }],
            meta: {},
          })),
        },
        {},
        {
          normalize: jest.fn((prompt) => ({ prompt, changes: [] })),
          validate: jest.fn(() => ({ errors: [], warnings: [] })),
        },
        executionService,
      ).buildTools({
        sessionId: 'session-1',
        userId: 7,
        mutationState,
      } as any);

      const pending = executionService.runTotalAgent(
        { sessionId: 'session-1', mutationState },
        (signal) =>
          tools.generate_script.execute(scriptInput(), { abortSignal: signal }),
      );
      const result = pending.catch((reason) => reason);
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
      }
      expect(mutationState.sideEffectStarted).toBe(true);
      await jest.advanceTimersByTimeAsync(5);
      const error = await result;

      expect(toVideoAgentError(error)).toEqual({
        code: 'OPERATION_STATUS_UNKNOWN',
        retryable: false,
        message: '操作状态未知，请刷新查看结果',
      });
    } finally {
      if (previousTotalTimeout === undefined) {
        delete process.env.VIDEO_AGENT_TOTAL_TIMEOUT_MS;
      } else {
        process.env.VIDEO_AGENT_TOTAL_TIMEOUT_MS = previousTotalTimeout;
      }
      if (previousScriptTimeout === undefined) {
        delete process.env.VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS;
      } else {
        process.env.VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS = previousScriptTimeout;
      }
      jest.useRealTimers();
    }
  });

  it('aborts the shared request after a script-save timeout and reports status unknown', async () => {
    jest.useFakeTimers();
    const previousToolTimeout = process.env.VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS;
    const previousTotalTimeout = process.env.VIDEO_AGENT_TOTAL_TIMEOUT_MS;
    process.env.VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS = '5';
    process.env.VIDEO_AGENT_TOTAL_TIMEOUT_MS = '100';

    try {
      const executionService = new VideoAgentExecutionService(
        new ConfigService(),
      );
      const requestController = new AbortController();
      const mutationState = { sideEffectStarted: false };
      let totalSignal: AbortSignal | undefined;
      const scriptRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((value) => value),
        save: jest.fn(() => new Promise(() => undefined)),
      };
      const tools = new (VideoToolsService as any)(
        {},
        scriptRepo,
        { update: jest.fn() },
        {},
        {
          parse: jest.fn(() => ({
            hook: '商品介绍',
            shots: [{ shot: 1 }],
            meta: {},
          })),
        },
        {},
        {
          normalize: jest.fn((prompt) => ({ prompt, changes: [] })),
          validate: jest.fn(() => ({ errors: [], warnings: [] })),
        },
        executionService,
      ).buildTools({
        sessionId: 'session-1',
        userId: 7,
        mutationState,
        abortRequest: (reason: Error) => requestController.abort(reason),
      } as any);

      const pending = executionService.runTotalAgent(
        {
          sessionId: 'session-1',
          parentSignal: requestController.signal,
          mutationState,
        },
        (signal) => {
          totalSignal = signal;
          return tools.generate_script.execute(scriptInput(), {
            abortSignal: signal,
          });
        },
      );
      const result = pending.catch((reason) => reason);
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
      }

      await jest.advanceTimersByTimeAsync(5);
      const error = await result;

      expect(requestController.signal.aborted).toBe(true);
      expect(totalSignal?.aborted).toBe(true);
      expect(toVideoAgentError(error)).toEqual({
        code: 'OPERATION_STATUS_UNKNOWN',
        retryable: false,
        message: '操作状态未知，请刷新查看结果',
      });
    } finally {
      if (previousToolTimeout === undefined) {
        delete process.env.VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS;
      } else {
        process.env.VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS = previousToolTimeout;
      }
      if (previousTotalTimeout === undefined) {
        delete process.env.VIDEO_AGENT_TOTAL_TIMEOUT_MS;
      } else {
        process.env.VIDEO_AGENT_TOTAL_TIMEOUT_MS = previousTotalTimeout;
      }
      jest.useRealTimers();
    }
  });

  it('uses the script-save deadline for generate_script', async () => {
    const timeout = new VideoAgentTimeoutError(
      'TOOL_TIMEOUT',
      'script_save',
      45000,
    );
    const executionService = {
      runTool: jest.fn(),
      runScriptSave: jest.fn().mockRejectedValue(timeout),
    } as unknown as VideoAgentExecutionService;
    const scriptRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value) => value),
      save: jest.fn().mockImplementation(async (value) => ({
        ...value,
        id: 9,
        version: 1,
      })),
    };
    const service = new (VideoToolsService as any)(
      {},
      scriptRepo,
      { update: jest.fn() },
      {},
      {
        parse: jest.fn(() => ({
          hook: '商品介绍',
          shots: [{ shot: 1 }],
          meta: {},
        })),
      },
      {},
      {
        normalize: jest.fn((prompt) => ({ prompt, changes: [] })),
        validate: jest.fn(() => ({ errors: [], warnings: [] })),
      },
      executionService,
    ) as VideoToolsService;
    const tools = service.buildTools({
      requestId: 'request-1',
      sessionId: 'session-1',
      userId: 7,
      parentSignal: new AbortController().signal,
    } as any) as any;

    await expect(
      tools.generate_script.execute({
        title: '脚本',
        storyboard_markdown:
          '### 镜头 1：开场 (0s - 3s)\n画面描述：商品\n旁白：介绍',
        seedance_prompt: '商品介绍',
        meta: {
          description: '商品介绍',
          hashtags: [],
          character: { mode: 'none', selectionSource: 'auto_selected' },
        },
      }),
    ).rejects.toBe(timeout);

    expect(executionService.runScriptSave).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-1',
        sessionId: 'session-1',
        toolName: 'generate_script',
      }),
      expect.any(Function),
    );
  });

  it('does not create or persist a script when its save deadline expires during version lookup', async () => {
    const timeout = new VideoAgentTimeoutError(
      'TOOL_TIMEOUT',
      'script_save',
      5,
    );
    const versionLookup = deferred<any>();
    const executionController = new AbortController();
    const executionService = {
      runTool: jest.fn(),
      runScriptSave: jest.fn(async (_context, work) => {
        const result = work(executionController.signal);
        executionController.abort(timeout);
        versionLookup.resolve(null);
        return result;
      }),
    } as unknown as VideoAgentExecutionService;
    const scriptRepo = {
      findOne: jest.fn().mockReturnValue(versionLookup.promise),
      create: jest.fn((value) => value),
      save: jest.fn(),
    };
    const sessionRepo = { update: jest.fn() };
    const service = new (VideoToolsService as any)(
      {},
      scriptRepo,
      sessionRepo,
      {},
      {
        parse: jest.fn(() => ({
          hook: '商品介绍',
          shots: [{ shot: 1 }],
          meta: {},
        })),
      },
      {},
      {
        normalize: jest.fn((prompt) => ({ prompt, changes: [] })),
        validate: jest.fn(() => ({ errors: [], warnings: [] })),
      },
      executionService,
    ) as VideoToolsService;
    const tools = service.buildTools({
      requestId: 'request-1',
      sessionId: 'session-1',
      userId: 7,
      parentSignal: new AbortController().signal,
    } as any) as any;

    await expect(
      tools.generate_script.execute(
        scriptInput(),
        { abortSignal: new AbortController().signal },
      ),
    ).rejects.toBe(timeout);

    expect(scriptRepo.create).not.toHaveBeenCalled();
    expect(scriptRepo.save).not.toHaveBeenCalled();
    expect(sessionRepo.update).not.toHaveBeenCalled();
  });

  it('does not persist a duplicate user message on a retry and rebuilds from the persisted message', async () => {
    let streamOptions: any;
    mockedCreateUIMessageStream.mockImplementation((options: any) => {
      streamOptions = options;
      return new ReadableStream();
    });
    const persistedUserMessage = {
      id: 44,
      sessionId: 'session-1',
      userId: 7,
      role: 'user',
      content: '生成分镜',
      parts: [{ type: 'text', text: '生成分镜' }],
      createdAt: new Date(),
    };
    const session = {
      sessionId: 'session-1',
      userId: 7,
      status: 'active',
      productProfile: {},
      topic: 'existing topic',
    };
    const sessionRepo = {
      findOne: jest.fn().mockResolvedValue(session),
      update: jest.fn(),
    };
    const messageRepo = {
      find: jest.fn().mockResolvedValue([persistedUserMessage]),
      findOne: jest.fn().mockResolvedValue(persistedUserMessage),
      save: jest.fn(),
    };
    const service = new (VideoService as any)(
      sessionRepo,
      messageRepo,
      { find: jest.fn().mockResolvedValue([]) },
      { findOne: jest.fn().mockResolvedValue(null) },
      { findOne: jest.fn().mockResolvedValue(null) },
      {},
      {},
      {},
      {},
      {},
      {},
    ) as VideoService;

    await service.streamChat(
      'session-1',
      [uiUserMessage('new client message id')],
      { userId: 7, retry: true },
    );

    expect(messageRepo.save).not.toHaveBeenCalled();
    expect(streamOptions.originalMessages).toEqual([
      expect.objectContaining({
        id: '44',
        role: 'user',
        parts: persistedUserMessage.parts,
      }),
    ]);
  });

  it('does not persist an assistant message after an incomplete stream', async () => {
    let streamOptions: any;
    mockedCreateUIMessageStream.mockImplementation((options: any) => {
      streamOptions = options;
      return new ReadableStream();
    });
    const session = {
      sessionId: 'session-1',
      userId: 7,
      status: 'active',
      productProfile: {},
      topic: 'existing topic',
    };
    const sessionRepo = {
      findOne: jest.fn().mockResolvedValue(session),
      update: jest.fn().mockResolvedValue({}),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
      })),
    };
    const messageRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue({ id: 3, content: '生成分镜' }),
    };
    const service = new (VideoService as any)(
      sessionRepo,
      messageRepo,
      { find: jest.fn().mockResolvedValue([]) },
      { findOne: jest.fn().mockResolvedValue(null) },
      { findOne: jest.fn().mockResolvedValue(null) },
      {},
      {},
      {},
      {},
      {},
      {},
    ) as VideoService;

    await service.streamChat(
      'session-1',
      [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: '生成分镜' }],
        } as any,
      ],
      { userId: 7 },
    );

    await streamOptions.onEnd({
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: '不完整回答' }],
        },
      ],
      isAborted: false,
    });

    expect(messageRepo.save).toHaveBeenCalledTimes(1);
  });

  it('stops request work on parent cancellation and does not persist an assistant message', async () => {
    let streamOptions: any;
    mockedCreateUIMessageStream.mockImplementation((options: any) => {
      streamOptions = options;
      return new ReadableStream();
    });
    const session = {
      sessionId: 'session-1',
      userId: 7,
      status: 'active',
      productProfile: {},
      topic: 'existing topic',
    };
    const sessionRepo = {
      findOne: jest.fn().mockResolvedValue(session),
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn(),
      })),
    };
    const messageRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue({ id: 3, content: '生成分镜' }),
    };
    const parent = new AbortController();
    const cancellation = new Error('client disconnected');
    const assetAnalysisService = {
      analyzePendingAssets: jest.fn(
        (_sessionId, _assetIds, signal: AbortSignal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    };
    const service = new (VideoService as any)(
      sessionRepo,
      messageRepo,
      { find: jest.fn().mockResolvedValue([]) },
      { findOne: jest.fn().mockResolvedValue(null) },
      { findOne: jest.fn().mockResolvedValue(null) },
      {},
      {},
      {},
      {},
      assetAnalysisService,
      {
        runTotalAgent: jest.fn((context, work) => work(context.parentSignal)),
      },
    ) as VideoService;

    await service.streamChat(
      'session-1',
      [uiUserMessage('user-1')],
      { userId: 7, parentSignal: parent.signal },
    );
    const execution = streamOptions.execute({ writer: { write: jest.fn() } });
    await Promise.resolve();
    parent.abort(cancellation);

    await expect(execution).rejects.toBe(cancellation);
    await streamOptions.onEnd({
      messages: [{
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', text: '不应持久化' }],
      }],
      isAborted: true,
    });

    expect(assetAnalysisService.analyzePendingAssets).toHaveBeenCalledWith(
      'session-1',
      [],
      parent.signal,
      undefined,
    );
    expect(messageRepo.save).toHaveBeenCalledTimes(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function scriptInput() {
  return {
    title: '脚本',
    storyboard_markdown:
      '### 镜头 1：开场 (0s - 3s)\n画面描述：商品\n旁白：介绍',
    seedance_prompt: '商品介绍',
    meta: {
      description: '商品介绍',
      hashtags: [],
      character: { mode: 'none', selectionSource: 'auto_selected' },
    },
  };
}

function uiUserMessage(id: string) {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text: '生成分镜' }],
  } as any;
}
