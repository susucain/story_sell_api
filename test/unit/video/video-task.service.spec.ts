jest.mock('ioredis', () => {
  class RedisMock {
    options = {};
    publish = jest.fn().mockResolvedValue(1);
    subscribe = jest
      .fn()
      .mockImplementation((_channel, callback) => callback(null));
    on = jest.fn();
  }

  return { __esModule: true, default: RedisMock };
});

import { VideoTaskService } from '../../../src/video/video-task.service';
import { Logger } from '@nestjs/common';

describe('VideoTaskService callbacks', () => {
  let service: VideoTaskService;
  let task: any;
  let repo: { findOne: jest.Mock; save: jest.Mock; count: jest.Mock };
  let sessionRepo: { update: jest.Mock };
  let messageRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let taskQueue: { add: jest.Mock };

  beforeEach(() => {
    task = {
      taskId: 'task-1',
      sessionId: 'session-1',
      status: 'queued',
      volcResponse: JSON.stringify({ id: 'task-1', status: 'queued' }),
    };
    repo = {
      findOne: jest.fn().mockResolvedValue(task),
      save: jest.fn().mockImplementation(async (value) => value),
      count: jest.fn().mockResolvedValue(0),
    };
    sessionRepo = { update: jest.fn().mockResolvedValue({}) };
    messageRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value) => value),
      save: jest.fn().mockImplementation(async (value) => value),
    };
    taskQueue = { add: jest.fn().mockResolvedValue({}) };

    const config = {
      get: jest.fn(
        (key: string) =>
          ({
            VIDEO_CALLBACK_TOKEN: 'test-callback-token',
            REDIS_HOST: 'localhost',
            REDIS_PORT: '6379',
          })[key],
      ),
    };

    service = new VideoTaskService(
      repo as any,
      {} as any,
      {} as any,
      sessionRepo as any,
      messageRepo as any,
      {} as any,
      taskQueue as any,
      config as any,
    );
  });

  it('validates the callback token', () => {
    expect(service.isValidCallbackToken('test-callback-token')).toBe(true);
    expect(service.isValidCallbackToken('wrong-token')).toBe(false);
    expect(service.isValidCallbackToken()).toBe(false);
  });

  it('does not apply or publish an identical callback twice', async () => {
    const callback = { id: 'task-1', status: 'running' };

    await expect(service.handleCallback(callback)).resolves.toEqual({
      received: true,
      applied: true,
    });
    await expect(service.handleCallback(callback)).resolves.toEqual({
      received: true,
      applied: false,
    });

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect((service as any).redis.publish).toHaveBeenCalledTimes(1);
  });

  it('does not allow a terminal task to be overwritten by a later callback', async () => {
    task.status = 'succeeded';
    task.volcResponse = JSON.stringify({
      id: 'task-1',
      status: 'succeeded',
      content: { video_url: 'https://example.test/video.mp4' },
    });

    await expect(
      service.handleCallback({ id: 'task-1', status: 'running' }),
    ).resolves.toEqual({
      received: true,
      applied: false,
    });

    expect(task.status).toBe('succeeded');
    expect(repo.save).not.toHaveBeenCalled();
    expect((service as any).redis.publish).not.toHaveBeenCalled();
  });

  it('does not allow a lower-priority status to overwrite the current status', async () => {
    task.status = 'running';
    task.volcResponse = JSON.stringify({ id: 'task-1', status: 'running' });

    await expect(
      service.handleCallback({ id: 'task-1', status: 'queued' }),
    ).resolves.toEqual({
      received: true,
      applied: false,
    });

    expect(task.status).toBe('running');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('queues OSS persistence when the model reports success', async () => {
    await expect(
      service.handleCallback({
        id: 'task-1',
        status: 'succeeded',
        content: { video_url: 'https://example.test/video.mp4' },
      }),
    ).resolves.toEqual({
      received: true,
      applied: true,
    });

    expect(task.status).toBe('persisting');
    expect(task.generatedVideoUrl).toBeUndefined();
    expect(taskQueue.add).toHaveBeenCalledWith(
      'persist-generated-video',
      { taskId: 'task-1' },
      expect.objectContaining({ jobId: 'persist-generated-video:task-1' }),
    );
    expect(messageRepo.save).not.toHaveBeenCalled();
  });

  it('keeps the session generating while another task is active', async () => {
    repo.count.mockResolvedValueOnce(1);

    await service.handleCallback({ id: 'task-1', status: 'failed' });

    expect(sessionRepo.update).toHaveBeenCalledWith(
      { sessionId: 'session-1' },
      { status: 'video_generating' },
    );
  });

  it('does not write a duplicate result message for an already processed callback', async () => {
    const callback = {
      id: 'task-1',
      status: 'failed',
      error: { message: '内容不合规' },
    };

    await service.handleCallback(callback);
    await service.handleCallback(callback);

    expect(messageRepo.save).toHaveBeenCalledTimes(1);
  });

  it('updates the submitted message instead of creating a second video message', async () => {
    const submittedMessage = {
      taskId: 'task-1',
      eventType: 'video_generation_submitted',
      content: '视频生成任务已提交，正在处理中。',
      metadata: {
        kind: 'video_generation_submitted',
        taskId: 'task-1',
        status: 'queued',
      },
    };
    messageRepo.findOne.mockResolvedValue(submittedMessage);

    await service.handleCallback({
      id: 'task-1',
      status: 'failed',
      error: { message: '内容不合规' },
    });

    expect(messageRepo.create).not.toHaveBeenCalled();
    expect(messageRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        eventType: 'video_generation_submitted',
        content: '视频生成未完成：内容不合规',
        metadata: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });
});

describe('VideoTaskService video generation', () => {
  let service: VideoTaskService;
  let scriptRepo: { findOne: jest.Mock };
  let assetRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let videoTaskRepo: { findOne: jest.Mock };
  let createdTaskParams: any;

  beforeEach(() => {
    scriptRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 10,
        sessionId: 'session-1',
        userId: 1,
        seedancePrompt: 'Edit the source video',
        meta: {
          ratio: '16:9',
          edit: {
            mode: 'full_video_edit',
            sourceAssetId: 20,
            sourceDurationSec: 12,
            targetStartSec: 2,
            targetEndSec: 6,
            preserveAudio: true,
          },
        },
      }),
    };
    assetRepo = {
      findOne: jest.fn().mockImplementation(({ where }) => {
        if ('url' in where) return Promise.resolve(null);
        return Promise.resolve({
          id: 20,
          sessionId: 'session-1',
          userId: 1,
          assetType: 'video',
          url: 'https://example.test/source.mp4',
        });
      }),
      find: jest.fn().mockResolvedValue([
        { assetType: 'video', url: 'https://example.test/source.mp4' },
        { assetType: 'image', url: 'https://example.test/reference.png' },
      ]),
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue({}),
    };

    videoTaskRepo = { findOne: jest.fn().mockResolvedValue(null) };

    const config = {
      get: jest.fn(
        (key: string) =>
          ({
            REDIS_HOST: 'localhost',
            REDIS_PORT: '6379',
          })[key],
      ),
    };
    service = new VideoTaskService(
      videoTaskRepo as any,
      scriptRepo as any,
      assetRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      config as any,
      {} as any,
    );
    jest.spyOn(service, 'createTask').mockImplementation(async (params) => {
      createdTaskParams = params;
      return { taskId: 'task-1' } as any;
    });
    jest
      .spyOn(service as any, 'markVideoGenerationStarted')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'saveTaskEventMessage')
      .mockResolvedValue(undefined);
  });

  it('includes uploaded reference images when generating a full video edit', async () => {
    await service.createTaskByScriptId(10, {
      sessionId: 'session-1',
      userId: 1,
      assets: [
        {
          type: 'image',
          url: 'https://example.test/reference.png',
          name: 'reference.png',
        },
      ],
    });

    expect(createdTaskParams).toEqual(
      expect.objectContaining({
        imageUrls: ['https://example.test/reference.png'],
        videoUrls: ['https://example.test/source.mp4'],
        duration: 12,
        ratio: '16:9',
      }),
    );
  });

  it('puts the user-selected portrait first and does not duplicate it', async () => {
    scriptRepo.findOne.mockResolvedValueOnce({
      id: 10,
      sessionId: 'session-1',
      userId: 1,
      seedancePrompt: 'Use portrait',
      meta: {
        character: {
          mode: 'user_portrait',
          primaryAssetId: 30,
          selectionSource: 'user_explicit',
        },
      },
    });
    assetRepo.findOne.mockImplementation(({ where }) => {
      if ('url' in where) return Promise.resolve(null);
      return where.id === 30
        ? Promise.resolve({
            id: 30,
            assetType: 'image',
            url: 'https://example.test/portrait.png',
          })
        : Promise.resolve(null);
    });
    assetRepo.find.mockResolvedValueOnce([
      { id: 30, assetType: 'image', url: 'https://example.test/portrait.png' },
      { id: 31, assetType: 'image', url: 'https://example.test/product.png' },
    ]);

    await service.createTaskByScriptId(10, {
      sessionId: 'session-1',
      userId: 1,
    });

    expect(createdTaskParams.imageUrls).toEqual([
      'https://example.test/portrait.png',
      'https://example.test/product.png',
    ]);
  });

  it('puts the selected preset avatar first', async () => {
    scriptRepo.findOne.mockResolvedValueOnce({
      id: 10,
      sessionId: 'session-1',
      userId: 1,
      seedancePrompt: 'Use preset',
      meta: {
        character: {
          mode: 'preset_avatar',
          presetAvatarId: 'asset-20260720212016-qfsgq',
          selectionSource: 'user_selected',
        },
      },
    });
    assetRepo.find.mockResolvedValueOnce([
      { id: 31, assetType: 'image', url: 'https://example.test/product.png' },
    ]);

    await service.createTaskByScriptId(10, {
      sessionId: 'session-1',
      userId: 1,
    });

    expect(createdTaskParams.imageUrls).toEqual([
      'asset://asset-20260720212016-qfsgq',
      'https://example.test/product.png',
    ]);
  });

  it('does not add a character image for scripts without a character', async () => {
    scriptRepo.findOne.mockResolvedValueOnce({
      id: 10,
      sessionId: 'session-1',
      userId: 1,
      seedancePrompt: 'No character',
      meta: { character: { mode: 'none', selectionSource: 'auto_selected' } },
    });
    assetRepo.find.mockResolvedValueOnce([
      { id: 31, assetType: 'image', url: 'https://example.test/product.png' },
    ]);

    await service.createTaskByScriptId(10, {
      sessionId: 'session-1',
      userId: 1,
    });

    expect(createdTaskParams.imageUrls).toEqual([
      'https://example.test/product.png',
    ]);
  });

  it('续写脚本首段只参考原片，不掺入会话其它素材', async () => {
    scriptRepo.findOne.mockResolvedValueOnce({
      id: 10,
      sessionId: 'session-1',
      userId: 1,
      seedancePrompt: 'Continue the story',
      meta: {
        duration: 10,
        ratio: '16:9',
        continuation: {
          mode: 'continuation',
          sourceAssetId: 20,
          sourceDurationSec: 12,
          continuityMode: 'extend',
        },
      },
    });
    // 会话里还存在其它视频/图片素材，续写时必须全部忽略
    assetRepo.find.mockResolvedValueOnce([
      { id: 21, assetType: 'video', url: 'https://example.test/other.mp4' },
      { id: 31, assetType: 'image', url: 'https://example.test/reference.png' },
    ]);

    await service.createTaskByScriptId(10, {
      sessionId: 'session-1',
      userId: 1,
    });

    expect(createdTaskParams).toEqual(
      expect.objectContaining({
        imageUrls: undefined,
        videoUrls: ['https://example.test/source.mp4'],
        firstFrameUrl: undefined,
        duration: 10,
        ratio: '16:9',
      }),
    );
  });

  it('续写脚本首段选择尾帧作首帧时反查原片尾帧', async () => {
    scriptRepo.findOne.mockResolvedValueOnce({
      id: 10,
      sessionId: 'session-1',
      userId: 1,
      seedancePrompt: 'Continue the story',
      meta: {
        duration: 10,
        continuation: {
          mode: 'continuation',
          sourceAssetId: 20,
          sourceDurationSec: 12,
          continuityMode: 'frame_bridge',
        },
      },
    });
    videoTaskRepo.findOne.mockResolvedValueOnce({
      generatedVideoUrl: 'https://example.test/source.mp4',
      lastFrameUrl: 'https://example.test/source-last-frame.png',
      status: 'succeeded',
    });
    assetRepo.find.mockResolvedValueOnce([
      { id: 21, assetType: 'video', url: 'https://example.test/other.mp4' },
    ]);

    await service.createTaskByScriptId(10, {
      sessionId: 'session-1',
      userId: 1,
    });

    expect(createdTaskParams).toEqual(
      expect.objectContaining({
        imageUrls: undefined,
        videoUrls: [],
        firstFrameUrl: 'https://example.test/source-last-frame.png',
        duration: 10,
      }),
    );
  });

  it('原片尾帧缺失时拒绝以尾帧作首帧续写', async () => {
    scriptRepo.findOne.mockResolvedValueOnce({
      id: 10,
      sessionId: 'session-1',
      userId: 1,
      seedancePrompt: 'Continue the story',
      meta: {
        duration: 10,
        continuation: {
          mode: 'continuation',
          sourceAssetId: 20,
          sourceDurationSec: 12,
          continuityMode: 'frame_bridge',
        },
      },
    });
    videoTaskRepo.findOne.mockResolvedValueOnce(null);

    await expect(
      service.createTaskByScriptId(10, { sessionId: 'session-1', userId: 1 }),
    ).rejects.toThrow('原片尾帧不可用');
  });

  it('分段生成的第 1 段带上主角色人像与会话参考图', async () => {
    scriptRepo.findOne.mockResolvedValueOnce({
      id: 10,
      sessionId: 'session-1',
      userId: 1,
      seedancePrompt: 'Segment 1',
      meta: {
        character: {
          mode: 'user_portrait',
          primaryAssetId: 30,
          selectionSource: 'user_explicit',
        },
      },
    });
    assetRepo.findOne.mockImplementation(({ where }) => {
      if ('url' in where) return Promise.resolve(null);
      return where.id === 30
        ? Promise.resolve({
            id: 30,
            assetType: 'image',
            url: 'https://example.test/portrait.png',
          })
        : Promise.resolve(null);
    });
    assetRepo.find.mockResolvedValueOnce([
      { id: 30, assetType: 'image', url: 'https://example.test/portrait.png' },
      { id: 31, assetType: 'image', url: 'https://example.test/product.png' },
    ]);

    await service.createTaskByScriptId(10, {
      sessionId: 'session-1',
      userId: 1,
      segment: {
        planId: 7,
        segmentIndex: 1,
        prompt: 'segment 1 prompt',
        duration: 8,
        continuityMode: 'extend',
      },
    });

    expect(createdTaskParams).toEqual(
      expect.objectContaining({
        imageUrls: [
          'https://example.test/portrait.png',
          'https://example.test/product.png',
        ],
        firstFrameUrl: undefined,
      }),
    );
  });

  it('分段生成的延长段同时带上参考图与上一段成片', async () => {
    scriptRepo.findOne.mockResolvedValueOnce({
      id: 10,
      sessionId: 'session-1',
      userId: 1,
      seedancePrompt: 'Segment 2',
      meta: { character: { mode: 'none', selectionSource: 'auto_selected' } },
    });
    assetRepo.find.mockResolvedValueOnce([
      { id: 31, assetType: 'image', url: 'https://example.test/product.png' },
    ]);

    await service.createTaskByScriptId(10, {
      sessionId: 'session-1',
      userId: 1,
      segment: {
        planId: 7,
        segmentIndex: 2,
        prompt: 'segment 2 prompt',
        duration: 8,
        continuityMode: 'extend',
        prevTask: {
          taskId: 'task-prev',
          generatedVideoUrl: 'https://example.test/segment-1.mp4',
        } as any,
      },
    });

    expect(createdTaskParams).toEqual(
      expect.objectContaining({
        imageUrls: ['https://example.test/product.png'],
        videoUrls: ['https://example.test/segment-1.mp4'],
        firstFrameUrl: undefined,
      }),
    );
  });

  it('首帧模式的段只传首帧，不附加参考图', async () => {
    scriptRepo.findOne.mockResolvedValueOnce({
      id: 10,
      sessionId: 'session-1',
      userId: 1,
      seedancePrompt: 'Segment 2 frame bridge',
      meta: { character: { mode: 'none', selectionSource: 'auto_selected' } },
    });

    await service.createTaskByScriptId(10, {
      sessionId: 'session-1',
      userId: 1,
      segment: {
        planId: 7,
        segmentIndex: 2,
        prompt: 'segment 2 prompt',
        duration: 8,
        continuityMode: 'frame_bridge',
        prevTask: {
          taskId: 'task-prev',
          lastFrameUrl: 'https://example.test/segment-1-last-frame.png',
        } as any,
      },
    });

    expect(createdTaskParams).toEqual(
      expect.objectContaining({
        imageUrls: undefined,
        firstFrameUrl: 'https://example.test/segment-1-last-frame.png',
      }),
    );
  });

  it('参考素材超出官方上限时直接中断并提示用户移除素材', async () => {
    scriptRepo.findOne.mockResolvedValueOnce({
      id: 10,
      sessionId: 'session-1',
      userId: 1,
      seedancePrompt: 'Too many assets',
      meta: { character: { mode: 'none', selectionSource: 'auto_selected' } },
    });
    assetRepo.find.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, index) => ({
        id: 100 + index,
        assetType: 'image',
        url: `https://example.test/image-${index + 1}.png`,
      })),
    );

    await expect(
      service.createTaskByScriptId(10, { sessionId: 'session-1', userId: 1 }),
    ).rejects.toThrow('请先移除多余素材');
  });
});

describe('VideoTaskService diagnostics', () => {
  it('logs only allowlisted task submission and provider response metadata', async () => {
    const taskRepo = {
      create: jest.fn((value) => value),
      save: jest.fn().mockImplementation(async (value) => value),
    };
    const config = {
      get: jest.fn(
        (key: string) =>
          ({
            YUNFEI_API_KEY: 'api-key',
            YUNFEI_API_URL: 'https://provider.example.test/tasks',
            YUNFEI_API_MODEL: 'configured-model',
            APP_BASE_URL: 'https://app.example.test',
            VIDEO_CALLBACK_TOKEN: 'callback-token',
            REDIS_HOST: 'localhost',
            REDIS_PORT: '6379',
          })[key],
      ),
    };
    const service = new VideoTaskService(
      taskRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      config as any,
      {} as any,
    );
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'task-1',
        status: 'queued',
        model: 'provider-model',
        provider_url: 'https://provider.example.test/private-result',
      }),
    } as Response);

    await service.createTask({
      sessionId: 'session-1',
      userId: 7,
      scriptId: 3,
      prompt: 'secret prompt must not be logged',
      imageUrls: ['https://assets.example.test/private-image.png'],
      videoUrls: ['https://assets.example.test/private-video.mp4'],
      duration: 12,
      ratio: '16:9',
    });

    expect(log.mock.calls.map(([message]) => message)).toEqual([
      JSON.stringify({
        event: 'video_task_submit',
        model: 'configured-model',
        duration: 12,
        ratio: '16:9',
        imageCount: 1,
        videoCount: 1,
      }),
      JSON.stringify({
        event: 'video_task_provider_response',
        taskId: 'task-1',
        status: 'queued',
        model: 'provider-model',
      }),
    ]);
    expect(log.mock.calls.flat().join('')).not.toContain('secret prompt');
    expect(log.mock.calls.flat().join('')).not.toContain('private-image');
    expect(log.mock.calls.flat().join('')).not.toContain('private-video');
    expect(log.mock.calls.flat().join('')).not.toContain('private-result');

    fetchSpy.mockRestore();
  });

  it('passes task abort signals to the provider and skips persistence after abort', async () => {
    const taskRepo = {
      create: jest.fn((value) => value),
      save: jest.fn(),
    };
    const service = createTaskService(taskRepo);
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (_url, init) => {
        receivedSignal = init?.signal as AbortSignal;
        controller.abort(new Error('request cancelled'));
        return {
          ok: true,
          json: async () => ({
            id: 'task-1',
            status: 'queued',
            model: 'provider-model',
          }),
        } as Response;
      });

    await expect(
      service.createTask({
        sessionId: 'session-1',
        userId: 7,
        scriptId: 3,
        prompt: 'prompt',
        signal: controller.signal,
      }),
    ).rejects.toThrow('request cancelled');

    expect(receivedSignal).toBe(controller.signal);
    expect(taskRepo.save).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it.each([
    ['submission', '视频生成服务请求失败: HTTP 502'],
    ['cancellation', '视频生成服务取消失败: HTTP 502'],
    ['listing', '视频生成服务查询失败: HTTP 502'],
  ])(
    'does not expose provider response bodies when %s fails',
    async (operation, message) => {
      const service = createTaskService({
        create: jest.fn((value) => value),
        save: jest.fn().mockResolvedValue({}),
        findOne: jest.fn().mockResolvedValue({
          taskId: 'task-1',
          userId: 7,
          status: 'queued',
        }),
      });
      const sensitiveBody =
        'https://provider.example.test/private?token=secret-prompt';
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => sensitiveBody,
      } as Response);

      const operationPromise =
        operation === 'submission'
          ? service.createTask({
              sessionId: 'session-1',
              userId: 7,
              scriptId: 3,
              prompt: sensitiveBody,
            })
          : operation === 'cancellation'
            ? service.cancelOrDeleteTask('task-1', 7)
            : service.listRemoteTasks();

      await expect(operationPromise).rejects.toThrow(message);
      await expect(operationPromise).rejects.not.toThrow('private');
      await expect(operationPromise).rejects.not.toThrow('secret-prompt');
      fetchSpy.mockRestore();
    },
  );
});

function createTaskService(taskRepo: any): VideoTaskService {
  const config = {
    get: jest.fn(
      (key: string) =>
        ({
          YUNFEI_API_KEY: 'api-key',
          YUNFEI_API_URL: 'https://provider.example.test/tasks',
          YUNFEI_API_MODEL: 'configured-model',
          APP_BASE_URL: 'https://app.example.test',
          VIDEO_CALLBACK_TOKEN: 'callback-token',
          REDIS_HOST: 'localhost',
          REDIS_PORT: '6379',
        })[key],
    ),
  };
  return new VideoTaskService(
    taskRepo,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    config as any,
    {} as any,
  );
}
