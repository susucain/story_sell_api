import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type VideoAgentTimeoutCode =
  | 'MODEL_TIMEOUT'
  | 'TOOL_TIMEOUT'
  | 'ASSET_PARSE_TIMEOUT'
  | 'AGENT_TOTAL_TIMEOUT';

export class VideoAgentTimeoutError extends Error {
  readonly retryable = true as const;

  constructor(
    readonly code: VideoAgentTimeoutCode,
    readonly phase: string,
    readonly durationMs: number,
  ) {
    super(`Video agent phase "${phase}" exceeded its deadline.`);
    this.name = 'VideoAgentTimeoutError';
  }
}

export interface VideoAgentPhaseContext {
  requestId?: string;
  sessionId?: string;
  toolName?: string;
  assetId?: number | string;
  parentSignal?: AbortSignal;
}

export interface VideoAgentPhaseOptions extends VideoAgentPhaseContext {
  phase: string;
  timeoutMs: number;
  timeoutCode: VideoAgentTimeoutCode;
}

export type VideoAgentPhaseWork<T> = (signal: AbortSignal) => Promise<T> | T;

const DEFAULTS = {
  modelFirstEventTimeoutMs: 90000,
  assetParseTimeoutMs: 90000,
  toolTimeoutMs: 30000,
  scriptSaveTimeoutMs: 45000,
  totalTimeoutMs: 300000,
  assetAnalysisConcurrency: 3,
} as const;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

@Injectable()
export class VideoAgentExecutionService {
  private readonly logger = new Logger(VideoAgentExecutionService.name);

  readonly modelFirstEventTimeoutMs: number;
  readonly assetParseTimeoutMs: number;
  readonly toolTimeoutMs: number;
  readonly scriptSaveTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly assetAnalysisConcurrency: number;

  constructor(configService: ConfigService) {
    this.modelFirstEventTimeoutMs = this.readPositiveInteger(
      configService,
      'VIDEO_AGENT_MODEL_FIRST_EVENT_TIMEOUT_MS',
      DEFAULTS.modelFirstEventTimeoutMs,
    );
    this.assetParseTimeoutMs = this.readPositiveInteger(
      configService,
      'VIDEO_AGENT_ASSET_PARSE_TIMEOUT_MS',
      DEFAULTS.assetParseTimeoutMs,
    );
    this.toolTimeoutMs = this.readPositiveInteger(
      configService,
      'VIDEO_AGENT_TOOL_TIMEOUT_MS',
      DEFAULTS.toolTimeoutMs,
    );
    this.scriptSaveTimeoutMs = this.readPositiveInteger(
      configService,
      'VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS',
      DEFAULTS.scriptSaveTimeoutMs,
    );
    this.totalTimeoutMs = this.readPositiveInteger(
      configService,
      'VIDEO_AGENT_TOTAL_TIMEOUT_MS',
      DEFAULTS.totalTimeoutMs,
    );
    this.assetAnalysisConcurrency = this.readPositiveInteger(
      configService,
      'VIDEO_AGENT_ASSET_ANALYSIS_CONCURRENCY',
      DEFAULTS.assetAnalysisConcurrency,
    );
  }

  runModelFirstEvent<T>(
    context: VideoAgentPhaseContext,
    work: VideoAgentPhaseWork<T>,
  ): Promise<T> {
    return this.run(
      {
        ...context,
        phase: 'model_first_event',
        timeoutMs: this.modelFirstEventTimeoutMs,
        timeoutCode: 'MODEL_TIMEOUT',
      },
      work,
    );
  }

  runAssetParse<T>(
    context: VideoAgentPhaseContext,
    work: VideoAgentPhaseWork<T>,
  ): Promise<T> {
    return this.run(
      {
        ...context,
        phase: 'asset_parse',
        timeoutMs: this.assetParseTimeoutMs,
        timeoutCode: 'ASSET_PARSE_TIMEOUT',
      },
      work,
    );
  }

  runStandardTool<T>(
    context: VideoAgentPhaseContext,
    work: VideoAgentPhaseWork<T>,
  ): Promise<T> {
    return this.run(
      {
        ...context,
        phase: 'tool',
        timeoutMs: this.toolTimeoutMs,
        timeoutCode: 'TOOL_TIMEOUT',
      },
      work,
    );
  }

  runTool<T>(
    context: VideoAgentPhaseContext,
    work: VideoAgentPhaseWork<T>,
  ): Promise<T> {
    return this.runStandardTool(context, work);
  }

  runScriptSave<T>(
    context: VideoAgentPhaseContext,
    work: VideoAgentPhaseWork<T>,
  ): Promise<T> {
    return this.run(
      {
        ...context,
        phase: 'script_save',
        timeoutMs: this.scriptSaveTimeoutMs,
        timeoutCode: 'TOOL_TIMEOUT',
      },
      work,
    );
  }

  runTotalAgent<T>(
    context: VideoAgentPhaseContext,
    work: VideoAgentPhaseWork<T>,
  ): Promise<T> {
    return this.run(
      {
        ...context,
        phase: 'agent_total',
        timeoutMs: this.totalTimeoutMs,
        timeoutCode: 'AGENT_TOTAL_TIMEOUT',
      },
      work,
    );
  }

  async run<T>(
    options: VideoAgentPhaseOptions,
    work: VideoAgentPhaseWork<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const controller = new AbortController();
    let timeoutError: VideoAgentTimeoutError | undefined;
    let abortListener: (() => void) | undefined;

    const onParentAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(options.parentSignal?.reason);
      }
    };

    if (options.parentSignal) {
      if (options.parentSignal.aborted) {
        onParentAbort();
      } else {
        options.parentSignal.addEventListener('abort', onParentAbort, {
          once: true,
        });
      }
    }

    if (controller.signal.aborted) {
      this.log(options, startedAt, 'aborted');
      throw controller.signal.reason;
    }

    const timeout = setTimeout(() => {
      timeoutError = new VideoAgentTimeoutError(
        options.timeoutCode,
        options.phase,
        options.timeoutMs,
      );
      controller.abort(timeoutError);
    }, options.timeoutMs);

    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason as Error);
      if (controller.signal.aborted) {
        abortListener();
      } else {
        controller.signal.addEventListener('abort', abortListener, {
          once: true,
        });
      }
    });

    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }

      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) {
            throw controller.signal.reason;
          }
          return work(controller.signal);
        }),
        aborted,
      ]);
      this.log(options, startedAt, 'succeeded');
      return result;
    } catch (error) {
      const isTimeout = error === timeoutError;
      const abortReason: unknown = controller.signal.reason;
      this.log(
        options,
        startedAt,
        isTimeout
          ? 'timed_out'
          : controller.signal.aborted
            ? 'aborted'
            : 'failed',
        abortReason instanceof VideoAgentTimeoutError
          ? abortReason.code
          : error instanceof VideoAgentTimeoutError
            ? error.code
            : undefined,
      );
      throw error;
    } finally {
      clearTimeout(timeout);
      if (abortListener) {
        controller.signal.removeEventListener('abort', abortListener);
      }
      options.parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }

  private readPositiveInteger(
    configService: ConfigService,
    key: string,
    defaultValue: number,
  ): number {
    const value = configService.get<string | number | undefined>(key);
    if (value === undefined) {
      return defaultValue;
    }

    const parsed = typeof value === 'number' ? value : Number(value);
    if (
      (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) ||
      !Number.isSafeInteger(parsed) ||
      parsed <= 0 ||
      parsed > MAX_TIMER_DELAY_MS
    ) {
      throw new Error(`${key} must be a positive integer.`);
    }

    return parsed;
  }

  private log(
    context: VideoAgentPhaseOptions,
    startedAt: number,
    outcome: 'succeeded' | 'timed_out' | 'aborted' | 'failed',
    errorCode?: VideoAgentTimeoutCode,
  ): void {
    this.logger.log(
      JSON.stringify({
        requestId: context.requestId,
        sessionId: context.sessionId,
        phase: context.phase,
        toolName: context.toolName,
        assetId: context.assetId,
        durationMs: Date.now() - startedAt,
        outcome,
        errorCode,
      }),
    );
  }
}
