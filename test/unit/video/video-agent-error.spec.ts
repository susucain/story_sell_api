jest.mock('ai', () => ({
  ToolLoopAgent: class {},
  createUIMessageStream: jest.fn(),
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
import { toVideoAgentError } from '../../../src/video/video.controller';
import {
  VideoAgentExecutionService,
  VideoAgentTimeoutError,
} from '../../../src/video/video-agent-execution.service';
import { VideoService } from '../../../src/video/video.service';
import { VideoToolsService } from '../../../src/video/video-tools.service';

const mockedCreateUIMessageStream =
  createUIMessageStream as jest.MockedFunction<typeof createUIMessageStream>;

describe('video agent stream errors', () => {
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
