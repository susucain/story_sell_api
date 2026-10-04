import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { registerTelemetry } from 'ai';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { LangfuseVercelAiSdkIntegration } from '@langfuse/vercel-ai-sdk';

/**
 * Langfuse 可观测性服务
 *
 * 负责初始化 OpenTelemetry NodeSDK 并将 Vercel AI SDK v7 的遥测数据导出到 Langfuse。
 * AI SDK v7 通过 `ai:telemetry` TracingChannel 发布 span 事件，必须用
 * `@langfuse/vercel-ai-sdk` 的集成（registerTelemetry）订阅，再由
 * `@langfuse/otel` 的 LangfuseSpanProcessor 导出到 Langfuse。
 * 需要在应用启动时尽早初始化，确保 AI SDK 的调用能被正确追踪。
 */
@Injectable()
export class LangfuseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LangfuseService.name);
  private sdk: NodeSDK | undefined;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const publicKey = this.configService.get<string>('LANGFUSE_PUBLIC_KEY');
    const secretKey = this.configService.get<string>('LANGFUSE_SECRET_KEY');
    const baseUrl = this.configService.get<string>('LANGFUSE_BASE_URL');
    const enabled =
      this.configService.get<string>('LANGFUSE_ENABLED') !== 'false';

    if (!enabled) {
      this.logger.log(
        'Langfuse tracing is disabled via LANGFUSE_ENABLED=false',
      );
      return;
    }

    if (!publicKey || !secretKey) {
      this.logger.warn(
        'Langfuse credentials not configured (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY). Tracing will not be sent.',
      );
      return;
    }

    const spanProcessor = new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl,
    });

    this.sdk = new NodeSDK({
      spanProcessors: [spanProcessor],
      serviceName: 'nest-langchain',
    });

    this.sdk.start();
    // 订阅 AI SDK v7 的 telemetry 事件，将其转换为 OTel span 交给 LangfuseSpanProcessor
    registerTelemetry(new LangfuseVercelAiSdkIntegration());
    this.logger.log(
      'Langfuse OpenTelemetry SDK started (AI SDK v7 integration)',
    );
  }

  async onModuleDestroy() {
    if (this.sdk) {
      try {
        await this.sdk.shutdown();
        this.logger.log('Langfuse OpenTelemetry SDK shut down');
      } catch (err) {
        this.logger.error('Failed to shut down Langfuse SDK', err);
      }
    }
  }
}
