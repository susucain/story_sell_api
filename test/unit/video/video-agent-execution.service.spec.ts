import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import {
  VideoAgentExecutionService,
  VideoAgentTimeoutError,
} from '../../../src/video/video-agent-execution.service';

const videoAgentEnvKeys = [
  'VIDEO_AGENT_MODEL_FIRST_EVENT_TIMEOUT_MS',
  'VIDEO_AGENT_ASSET_PARSE_TIMEOUT_MS',
  'VIDEO_AGENT_TOOL_TIMEOUT_MS',
  'VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS',
  'VIDEO_AGENT_TOTAL_TIMEOUT_MS',
  'VIDEO_AGENT_ASSET_ANALYSIS_CONCURRENCY',
] as const;

type VideoAgentEnvKey = (typeof videoAgentEnvKeys)[number];

describe('VideoAgentExecutionService', () => {
  const originalEnv: Partial<Record<VideoAgentEnvKey, string | undefined>> = {};

  beforeAll(() => {
    for (const key of videoAgentEnvKeys) {
      originalEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of videoAgentEnvKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function createService() {
    return new VideoAgentExecutionService(new ConfigService());
  }

  it('aborts model work at its deadline and rejects with a retryable model timeout', async () => {
    jest.useFakeTimers();
    process.env.VIDEO_AGENT_MODEL_FIRST_EVENT_TIMEOUT_MS = '5';
    const service = createService();
    let receivedSignal: AbortSignal | undefined;

    const result = service.runModelFirstEvent(
      { requestId: 'request-1', sessionId: 'session-1' },
      async (signal) => {
        receivedSignal = signal;
        return new Promise<void>(() => undefined);
      },
    );
    const rejection = expect(result).rejects.toMatchObject({
      code: 'MODEL_TIMEOUT',
      retryable: true,
      phase: 'model_first_event',
      durationMs: 5,
    });

    await jest.advanceTimersByTimeAsync(5);

    await rejection;
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBeInstanceOf(VideoAgentTimeoutError);
  });

  it('propagates a parent cancellation without rewriting its reason', async () => {
    const service = createService();
    const parent = new AbortController();
    const reason = new Error('request cancelled upstream');
    let receivedSignal: AbortSignal | undefined;

    const result = service.runTool(
      {
        requestId: 'request-1',
        toolName: 'save_script',
        parentSignal: parent.signal,
      },
      async (signal) => {
        receivedSignal = signal;
        return new Promise<void>(() => undefined);
      },
    );
    await Promise.resolve();
    const rejection = expect(result).rejects.toBe(reason);

    parent.abort(reason);

    await rejection;
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBe(reason);
  });

  it('does not start work when its parent is cancelled immediately after runTool returns', async () => {
    const service = createService();
    const parent = new AbortController();
    const reason = new Error('request cancelled before deferred work starts');
    const work = jest.fn(() => Promise.resolve());

    const result = service.runTool({ parentSignal: parent.signal }, work);
    const rejection = expect(result).rejects.toBe(reason);
    parent.abort(reason);

    await rejection;
    expect(work).not.toHaveBeenCalled();
  });

  it('does not start work when its parent is already cancelled', async () => {
    const service = createService();
    const parent = new AbortController();
    const reason = new Error('request cancelled before phase start');
    const work = jest.fn();
    parent.abort(reason);

    await expect(
      service.runTool(
        { requestId: 'request-1', parentSignal: parent.signal },
        work,
      ),
    ).rejects.toBe(reason);
    expect(work).not.toHaveBeenCalled();
  });

  it('logs an inherited timeout code when its parent is already cancelled', async () => {
    const service = createService();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const parent = new AbortController();
    const parentTimeout = new VideoAgentTimeoutError(
      'AGENT_TOTAL_TIMEOUT',
      'agent_total',
      300000,
    );
    parent.abort(parentTimeout);

    await expect(
      service.runTool(
        { requestId: 'request-1', parentSignal: parent.signal },
        jest.fn(),
      ),
    ).rejects.toBe(parentTimeout);

    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual(
      expect.objectContaining({
        phase: 'tool',
        outcome: 'aborted',
        errorCode: 'AGENT_TOTAL_TIMEOUT',
      }),
    );
  });

  it('writes a redacted structured phase log', async () => {
    const service = createService();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const suppliedUrl =
      'https://secret.example.test/private-input.mp4?token=never-log-this';

    await expect(
      service.runTool(
        {
          requestId: 'request-1',
          sessionId: 'session-1',
          toolName: 'extract_audio',
          assetId: 42,
        },
        () => ({ source: suppliedUrl }),
      ),
    ).resolves.toEqual({ source: suppliedUrl });

    const output = String(log.mock.calls[0][0]);
    const parsedOutput = JSON.parse(output) as Record<string, unknown>;
    expect(parsedOutput).toEqual(
      expect.objectContaining({
        requestId: 'request-1',
        sessionId: 'session-1',
        phase: 'tool',
        toolName: 'extract_audio',
        assetId: 42,
        outcome: 'succeeded',
      }),
    );
    expect(typeof parsedOutput.durationMs).toBe('number');
    expect(output).not.toContain(suppliedUrl);
  });

  it('logs the parent timeout code when a child phase aborts', async () => {
    const service = createService();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const parent = new AbortController();
    const parentTimeout = new VideoAgentTimeoutError(
      'AGENT_TOTAL_TIMEOUT',
      'agent_total',
      300000,
    );

    const result = service.runTool(
      { requestId: 'request-1', parentSignal: parent.signal },
      (signal) =>
        new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('provider cancelled')),
            {
              once: true,
            },
          );
        }),
    );
    const rejection = expect(result).rejects.toBe(parentTimeout);

    await Promise.resolve();
    parent.abort(parentTimeout);

    await rejection;
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual(
      expect.objectContaining({
        phase: 'tool',
        outcome: 'aborted',
        errorCode: 'AGENT_TOTAL_TIMEOUT',
      }),
    );
  });

  it('uses defaults and accepts positive integer environment overrides', () => {
    const defaults = createService();

    expect(defaults.modelFirstEventTimeoutMs).toBe(180000);
    expect(defaults.assetParseTimeoutMs).toBe(180000);
    expect(defaults.toolTimeoutMs).toBe(60000);
    expect(defaults.scriptSaveTimeoutMs).toBe(90000);
    expect(defaults.totalTimeoutMs).toBe(900000);
    expect(defaults.roleAgentTimeoutMs).toBe(240000);
    expect(defaults.assetAnalysisConcurrency).toBe(3);

    process.env.VIDEO_AGENT_MODEL_FIRST_EVENT_TIMEOUT_MS = '123';
    process.env.VIDEO_AGENT_ASSET_PARSE_TIMEOUT_MS = '124';
    process.env.VIDEO_AGENT_TOOL_TIMEOUT_MS = '125';
    process.env.VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS = '126';
    process.env.VIDEO_AGENT_TOTAL_TIMEOUT_MS = '127';
    process.env.VIDEO_AGENT_ASSET_ANALYSIS_CONCURRENCY = '3';

    const overridden = createService();

    expect(overridden.modelFirstEventTimeoutMs).toBe(123);
    expect(overridden.assetParseTimeoutMs).toBe(124);
    expect(overridden.toolTimeoutMs).toBe(125);
    expect(overridden.scriptSaveTimeoutMs).toBe(126);
    expect(overridden.totalTimeoutMs).toBe(127);
    expect(overridden.assetAnalysisConcurrency).toBe(3);
  });

  it('rejects non-positive integer environment values', () => {
    process.env.VIDEO_AGENT_TOOL_TIMEOUT_MS = '0';

    expect(createService).toThrow(
      'VIDEO_AGENT_TOOL_TIMEOUT_MS must be a positive integer.',
    );
  });

  it('rejects asset analysis concurrency above three', () => {
    process.env.VIDEO_AGENT_ASSET_ANALYSIS_CONCURRENCY = '4';

    expect(createService).toThrow(
      'VIDEO_AGENT_ASSET_ANALYSIS_CONCURRENCY must be a positive integer no greater than 3.',
    );
  });

  it('rejects values larger than the maximum Node timer delay', () => {
    process.env.VIDEO_AGENT_TOTAL_TIMEOUT_MS = '2147483648';

    expect(createService).toThrow(
      'VIDEO_AGENT_TOTAL_TIMEOUT_MS must be a positive integer.',
    );
  });
});
