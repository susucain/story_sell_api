import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const RUN_CANCEL_CHANNEL = 'run-cancel';

/**
 * 跨实例取消信号。
 *
 * 执行 run 的进程才有它的 AbortController，所以取消请求落在别的实例上时无法直接
 * 中止。这里用 Redis pub/sub 做快路径：任意实例发布 runId，持有该 run 的实例收到
 * 后立即中止。pub/sub 不可靠（订阅瞬时中断会丢消息），因此调用方还会写
 * `agent_runs.cancel_requested_at` 作为持久兜底，由心跳轮询补齐。
 */
@Injectable()
export class RunCancelService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunCancelService.name);
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers = new Set<(runId: string) => void>();

  constructor(configService: ConfigService) {
    const redisUrl = configService.get<string>('REDIS_URL');
    const createClient = () =>
      redisUrl
        ? new Redis(redisUrl)
        : new Redis({
            host: configService.get<string>('REDIS_HOST') || 'localhost',
            port: Number(configService.get<string>('REDIS_PORT') || 6379),
            password: configService.get<string>('REDIS_PASSWORD') || undefined,
          });
    this.publisher = createClient();
    this.subscriber = createClient();
    this.publisher.on('error', (error: Error) => {
      this.logger.error(`RunCancelService 发布端 Redis 错误: ${error.message}`);
    });
    this.subscriber.on('error', (error: Error) => {
      this.logger.error(`RunCancelService 订阅端 Redis 错误: ${error.message}`);
    });
  }

  onModuleInit(): void {
    void this.subscriber.subscribe(RUN_CANCEL_CHANNEL);
    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel !== RUN_CANCEL_CHANNEL) return;
      this.handlers.forEach((handler) => handler(message));
    });
  }

  /** 广播一次取消；失败只记日志，不影响调用方（DB 兜底仍会生效） */
  async publishCancel(runId: string): Promise<void> {
    try {
      await this.publisher.publish(RUN_CANCEL_CHANNEL, runId);
    } catch (error: unknown) {
      this.logger.warn(
        JSON.stringify({
          event: 'run_cancel_publish_failed',
          runId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /** 注册取消处理器，返回注销函数 */
  onCancel(handler: (runId: string) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onModuleDestroy(): void {
    void this.publisher.quit();
    void this.subscriber.quit();
  }
}
