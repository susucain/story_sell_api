import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { UIMessageChunk } from 'ai';

/**
 * 运行事件类型。事件日志是可重放的真相来源：
 * - `panel`      面板全量快照（复用 ProcessTracker 的 emit 语义）
 * - `text-delta` 正文增量（按 100ms 合批，携带文本 part id）
 * - `text-meta`  文本 part 的 step 归属/角色元数据
 * - `result`     结果引用（如 scriptId）
 * - `error`      运行期错误
 * - `done`       运行结束（正常或中止）
 */
export type RunEventType =
  | 'panel'
  | 'text-delta'
  | 'text-meta'
  | 'result'
  | 'error'
  | 'done';

export interface RunEvent {
  /** Redis Stream 条目 ID，同时作为 SSE 的 `id:` 与重放游标 */
  id: string;
  type: RunEventType;
  data: unknown;
}

export const RUN_EVENTS_MAXLEN = 5000;
export const RUN_EVENTS_TTL_SECONDS = 60 * 60 * 24;

/** 单个 run 的事件日志 */
@Injectable()
export class RunEventService implements OnModuleDestroy {
  private readonly logger = new Logger(RunEventService.name);
  private readonly redis: Redis;

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    this.redis = redisUrl
      ? new Redis(redisUrl)
      : new Redis({
          host: this.configService.get<string>('REDIS_HOST') || 'localhost',
          port: Number(this.configService.get<string>('REDIS_PORT') || 6379),
          password:
            this.configService.get<string>('REDIS_PASSWORD') || undefined,
        });
    this.redis.on('error', (error: Error) => {
      this.logger.error(`RunEventService Redis 错误: ${error.message}`);
    });
  }

  onModuleDestroy() {
    void this.redis.quit();
  }

  private eventsKey(runId: string): string {
    return `run:${runId}:events`;
  }

  /** 追加一条事件，返回其游标（条目 ID）；失败时返回 null，不打断主流水线。 */
  async append(
    runId: string,
    type: RunEventType,
    data: unknown,
  ): Promise<string | null> {
    try {
      const id = await this.redis.xadd(
        this.eventsKey(runId),
        'MAXLEN',
        '~',
        RUN_EVENTS_MAXLEN,
        '*',
        'type',
        type,
        'data',
        JSON.stringify(data ?? null),
      );
      await this.redis.expire(this.eventsKey(runId), RUN_EVENTS_TTL_SECONDS);
      return id;
    } catch (error: unknown) {
      this.logger.error(
        JSON.stringify({
          event: 'run_event_append_failed',
          runId,
          type,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  }

  /**
   * 读取 `after` 之后的事件。`after` 为游标（条目 ID），缺省从头开始。
   * 返回的事件按 seq 递增。
   */
  async readAfter(runId: string, after?: string): Promise<RunEvent[]> {
    const start = after ? `(${after}` : '-';
    try {
      const entries = await this.redis.xrange(
        this.eventsKey(runId),
        start,
        '+',
      );
      return entries.map(([id, fields]) => this.toEvent(id, fields));
    } catch (error: unknown) {
      this.logger.error(
        JSON.stringify({
          event: 'run_event_read_failed',
          runId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return [];
    }
  }

  /**
   * 开一条尾随专用的独立连接。
   *
   * 阻塞读（XREAD BLOCK）不能和写入共用同一条连接：Redis 对同一连接串行执行命令，
   * 阻塞读在途时后续的 XADD 会被压在缓冲里不执行——而阻塞读恰恰在等这条 XADD，
   * 于是只能等 blockMs 超时才能推进（实测写入被压后整整一个阻塞周期）。
   * 因此每个订阅各开一条连接，读写互不阻塞；断开时关掉它即可中断在途 XREAD。
   */
  createTailClient(): Redis {
    const client = this.redis.duplicate();
    client.on('error', (error: Error) => {
      this.logger.warn(`run 事件尾随连接错误: ${error.message}`);
    });
    return client;
  }

  /**
   * 阻塞读取 `after` 之后的事件（最长 blockMs 毫秒）。
   * 超时无新事件时返回 null，供调用方发心跳。
   * `client` 必须是由 `createTailClient()` 开出的独立连接。
   */
  async readAfterBlocking(
    runId: string,
    after: string,
    blockMs: number,
    client: Redis,
  ): Promise<RunEvent[] | null> {
    try {
      const result = await client.xread(
        'BLOCK',
        blockMs,
        'STREAMS',
        this.eventsKey(runId),
        after,
      );
      if (!result || result.length === 0) return null;
      const items = result[0][1];
      if (!items || items.length === 0) return null;
      return items.map(([id, fields]) => this.toEvent(id, fields));
    } catch (error: unknown) {
      // 连接抖动等异常：交给调用方按心跳节奏重试
      if (
        error instanceof Error &&
        /Connection is closed/i.test(error.message)
      ) {
        throw error;
      }
      this.logger.warn(
        JSON.stringify({
          event: 'run_event_tail_failed',
          runId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  }

  /**
   * 把 UI 消息流包一层：边放行边把可恢复的事件写进日志。
   * 返回的新流与输入流 chunk 一一对应，录制失败不影响主链路。
   */
  recordStream(
    runId: string,
    stream: ReadableStream<UIMessageChunk>,
  ): ReadableStream<UIMessageChunk> {
    const recorder = new RunEventRecorder(this, runId);
    return stream.pipeThrough<UIMessageChunk>(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform: (chunk, controller) => {
          recorder.onChunk(chunk);
          controller.enqueue(chunk);
        },
        flush: async () => {
          await recorder.finish();
        },
      }),
    );
  }

  private toEvent(id: string, fields: string[]): RunEvent {
    const map: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      map[fields[i]] = fields[i + 1];
    }
    let data: unknown = null;
    try {
      data = map.data ? JSON.parse(map.data) : null;
    } catch {
      data = null;
    }
    return {
      id,
      type: (map.type as RunEventType) ?? 'panel',
      data,
    };
  }
}

/** 单条运行的录制器：合并正文增量、串行落库以保持事件顺序。 */
class RunEventRecorder {
  private tail: Promise<void> = Promise.resolve();
  private pendingText: { id: string; delta: string } | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private finished = false;

  constructor(
    private readonly service: RunEventService,
    private readonly runId: string,
  ) {}

  onChunk(chunk: UIMessageChunk): void {
    if (!chunk || typeof chunk.type !== 'string') return;
    switch (chunk.type) {
      case 'text-delta': {
        const delta =
          (chunk as { delta?: unknown; text?: unknown }).delta ??
          (chunk as { text?: unknown }).text;
        const id = (chunk as { id?: unknown }).id;
        if (typeof delta === 'string' && delta && typeof id === 'string') {
          this.pushText(id, delta);
        }
        return;
      }
      case 'data-process-state': {
        this.flushText();
        this.enqueue('panel', (chunk as { data?: unknown }).data);
        return;
      }
      case 'data-text-meta': {
        this.flushText();
        this.enqueue('text-meta', (chunk as { data?: unknown }).data);
        return;
      }
      case 'tool-output-available': {
        const output = (chunk as { output?: unknown }).output;
        const scriptId = (output as { script_id?: unknown } | undefined)
          ?.script_id;
        if (typeof scriptId === 'number') {
          this.flushText();
          this.enqueue('result', { scriptId });
        }
        return;
      }
      case 'error': {
        this.flushText();
        this.enqueue('error', {
          errorText: (chunk as { errorText?: unknown }).errorText,
        });
        return;
      }
      case 'finish': {
        this.markDone();
        return;
      }
      default:
        return;
    }
  }

  /** 流结束（正常或中止）时收尾 */
  async finish(): Promise<void> {
    this.markDone();
    await this.tail;
  }

  private markDone(): void {
    if (this.finished) return;
    this.finished = true;
    this.flushText();
    this.enqueue('done', {});
  }

  private pushText(id: string, delta: string): void {
    if (this.pendingText && this.pendingText.id === id) {
      this.pendingText.delta += delta;
    } else {
      this.flushText();
      this.pendingText = { id, delta };
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushText(), 100);
    }
  }

  private flushText(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pendingText) return;
    const payload = this.pendingText;
    this.pendingText = null;
    this.enqueue('text-delta', payload);
  }

  private enqueue(type: RunEventType, data: unknown): void {
    this.tail = this.tail
      .then(() => this.service.append(this.runId, type, data))
      .then(() => undefined)
      .catch(() => undefined);
  }
}
