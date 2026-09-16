import { generateObject } from 'ai';
import { VideoAgentExecutionService, VideoAgentTimeoutError } from '../../../src/video/video-agent-execution.service';
import { VideoAsset } from '../../../src/video/entities/video-asset.entity';
import { ProcessTracker } from '../../../src/video/process-tracker';
import { VideoAssetAnalysisService } from '../../../src/video/video-asset-analysis.service';
import { VideoLLMService } from '../../../src/video/video-llm.service';

jest.mock('ai', () => ({
  generateObject: jest.fn(),
}));

jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(),
}));

const mockedGenerateObject = generateObject as jest.MockedFunction<typeof generateObject>;

function createAsset(id: number): VideoAsset {
  return {
    id,
    sessionId: 'session-1',
    userId: 7,
    assetType: 'image',
    assetPurpose: 'all',
    contentCategory: 'other',
    name: `asset-${id}`,
    url: `https://example.test/${id}.jpg`,
    thumbnailUrl: '',
    parsedContent: undefined,
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTick() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('VideoAssetAnalysisService', () => {
  const assetRepo = {
    find: jest.fn(),
    update: jest.fn(),
    save: jest.fn(),
  };
  const llmService = {
    getLanguageModel: jest.fn().mockReturnValue({}),
  } as unknown as VideoLLMService;
  const executionService = {
    assetAnalysisConcurrency: 3,
    runAssetParse: jest.fn(),
  } as unknown as VideoAgentExecutionService;

  let service: VideoAssetAnalysisService;

  beforeEach(() => {
    jest.resetAllMocks();
    (llmService.getLanguageModel as jest.Mock).mockReturnValue({});
    (executionService.runAssetParse as jest.Mock).mockImplementation(
      (_context, work) => work(new AbortController().signal),
    );
    assetRepo.find.mockResolvedValue([]);
    assetRepo.update.mockResolvedValue({ affected: 1 });
    assetRepo.save.mockImplementation(async (asset) => asset);
    service = new VideoAssetAnalysisService(
      assetRepo as any,
      llmService,
      executionService,
    );
  });

  it('starts no more than three visual analyses before any of five calls resolve', async () => {
    assetRepo.find.mockResolvedValue([1, 2, 3, 4, 5].map(createAsset));
    const calls = Array.from({ length: 5 }, () => deferred<any>());
    let nextCall = 0;
    mockedGenerateObject.mockImplementation(() => calls[nextCall++]!.promise as any);

    const batch = service.analyzePendingAssets('session-1', [1, 2, 3, 4, 5]);

    await nextTick();
    expect(mockedGenerateObject).toHaveBeenCalledTimes(3);

    calls.slice(0, 3).forEach((call, index) => {
      call.resolve({
        object: { summary: `summary-${index}`, contentCategory: 'product' },
      });
    });
    await nextTick();

    expect(mockedGenerateObject).toHaveBeenCalledTimes(5);

    calls.slice(3).forEach((call, index) => {
      call.resolve({
        object: { summary: `summary-later-${index}`, contentCategory: 'food' },
      });
    });
    await expect(batch).resolves.toHaveLength(5);
  });

  it('persists a successful visual analysis with its summary and category', async () => {
    assetRepo.find.mockResolvedValue([createAsset(1)]);
    mockedGenerateObject.mockResolvedValue({
      object: { summary: 'A red bottle on a table', contentCategory: 'product' },
    } as any);

    const asset = {
      ...createAsset(1),
      assetType: 'video' as const,
      parsedContent: { durationSec: 12 },
    };
    assetRepo.find.mockResolvedValue([asset]);

    await expect(service.analyzePendingAssets('session-1', [1])).resolves.toEqual([
      {
        assetId: 1,
        status: 'parsed',
        summary: 'A red bottle on a table',
        contentCategory: 'product',
      },
    ]);
    expect(assetRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 1,
      parsedContent: {
        durationSec: 12,
        summary: 'A red bottle on a table',
        contentCategory: 'product',
      },
      contentCategory: 'product',
      status: 'parsed',
    }));
  });

  it('records a timed out asset as failed while a sibling succeeds', async () => {
    const timedOutAsset = {
      ...createAsset(1),
      assetType: 'video' as const,
      parsedContent: { durationSec: 9 },
    };
    assetRepo.find.mockResolvedValue([timedOutAsset, createAsset(2)]);
    (executionService.runAssetParse as jest.Mock).mockImplementation(
      (context, work) => context.assetId === 1
        ? Promise.reject(new VideoAgentTimeoutError('ASSET_PARSE_TIMEOUT', 'asset_parse', 1))
        : work(new AbortController().signal),
    );
    mockedGenerateObject.mockResolvedValue({
      object: { summary: 'Fresh fruit', contentCategory: 'food' },
    } as any);

    await expect(service.analyzePendingAssets('session-1', [1, 2])).resolves.toEqual([
      { assetId: 1, status: 'failed', errorCode: 'ASSET_PARSE_TIMEOUT' },
      {
        assetId: 2,
        status: 'parsed',
        summary: 'Fresh fruit',
        contentCategory: 'food',
      },
    ]);
    expect(assetRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 1,
      parsedContent: {
        durationSec: 9,
        errorCode: 'ASSET_PARSE_TIMEOUT',
      },
      status: 'failed',
    }));
  });

  it('returns a failed result instead of rejecting the batch for a provider error', async () => {
    assetRepo.find.mockResolvedValue([createAsset(1)]);
    mockedGenerateObject.mockRejectedValue(new Error('provider details must not escape'));

    await expect(service.analyzePendingAssets('session-1', [1])).resolves.toEqual([
      { assetId: 1, status: 'failed', errorCode: 'ASSET_PARSE_FAILED' },
    ]);
  });

  it('does not call the model when no eligible asset is claimed', async () => {
    assetRepo.find.mockResolvedValue([createAsset(1)]);
    assetRepo.update.mockResolvedValue({ affected: 0 });

    await expect(service.analyzePendingAssets('session-1', [1])).resolves.toEqual([]);
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });

  it('analyzes only asset IDs supplied for the current message', async () => {
    const currentAsset = createAsset(1);
    const historicalAsset = createAsset(2);
    assetRepo.find.mockImplementation(async ({ where }) => {
      const ids = (where.id as any)._value as number[];
      return [currentAsset, historicalAsset].filter((asset) => ids.includes(asset.id));
    });
    mockedGenerateObject.mockResolvedValue({
      object: { summary: 'Current asset', contentCategory: 'product' },
    } as any);

    await expect(service.analyzePendingAssets('session-1', [1])).resolves.toEqual([
      {
        assetId: 1,
        status: 'parsed',
        summary: 'Current asset',
        contentCategory: 'product',
      },
    ]);
    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
    expect(assetRepo.find).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: expect.objectContaining({ _value: [1] }),
      }),
    }));
  });

  it('rethrows a parent request cancellation before starting model work', async () => {
    assetRepo.find.mockResolvedValue([createAsset(1)]);
    const controller = new AbortController();
    const reason = new Error('request cancelled');
    controller.abort(reason);

    await expect(
      service.analyzePendingAssets('session-1', [1], controller.signal),
    ).rejects.toBe(reason);
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });

  it('propagates the parent abort reason when cancellation races a provider error', async () => {
    assetRepo.find.mockResolvedValue([createAsset(1)]);
    const controller = new AbortController();
    const reason = new Error('request cancelled');
    (executionService.runAssetParse as jest.Mock).mockImplementation(async () => {
      controller.abort(reason);
      throw new Error('provider failure');
    });

    await expect(
      service.analyzePendingAssets('session-1', [1], controller.signal),
    ).rejects.toBe(reason);
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });
});

describe('ProcessTracker asset failures', () => {
  it('marks a failed asset with a retryable description and completes the material phase', () => {
    const writer = { write: jest.fn() };
    const tracker = new ProcessTracker({
      writer,
      analysisAssets: [createAsset(1)],
    });

    tracker.start();
    tracker.markAssetFailed(1, 'ASSET_PARSE_TIMEOUT');

    const state = writer.write.mock.calls.at(-1)![0].data;
    const phase = state.phases.find((item: any) => item.id === 'parse-materials');
    expect(phase.status).toBe('completed');
    expect(phase.items[0]).toMatchObject({
      status: 'error',
      description: '素材解析失败，可在后续请求中重试',
      tag: { text: '可重试', type: 'info' },
    });
  });
});
