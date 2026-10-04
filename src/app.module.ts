import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BookModule } from './book/book.module';
import { AiModule } from './ai/ai.module';
import { MailerModule } from '@nestjs-modules/mailer';
import { ConfigService, ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from './users/users.module';
import { User } from './users/entities/user.entity';
import { AuthSession } from './auth/entities/auth-session.entity';
import { ScheduleModule } from '@nestjs/schedule';
import { JobModule } from './job/job.module';
import { Job } from './job/entities/job.entity';
import { ToolModule } from './tool/tool.module';
import { SpeechModule } from './speech/speech.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { OssModule } from './oss/oss.module';
import { BullModule } from '@nestjs/bull';
import { OssFile } from './oss/entities/oss.entity';
import { VideoModule } from './video/video.module';
import { VideoSession } from './video/entities/video-session.entity';
import { VideoTask } from './video/entities/video-task.entity';
import { VideoGenerationPlan } from './video/entities/video-generation-plan.entity';
import { VideoMessage } from './video/entities/video-message.entity';
import { VideoAsset } from './video/entities/video-asset.entity';
import { VideoScript } from './video/entities/video-script.entity';
import { AgentRun } from './video/entities/agent-run.entity';
import { ToolInvocation } from './video/entities/tool-invocation.entity';
import { LangfuseModule } from './langfuse/langfuse.module';
import { AuthModule } from './auth/auth.module';
import { ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [
    // 尽早初始化 Langfuse OpenTelemetry SDK，确保 AI SDK 调用可被追踪
    LangfuseModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
    }),
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      {
        limit: 100,
        name: 'default',
        ttl: 60_000,
      },
    ]),
    BookModule,
    AiModule,
    // 依赖configService，需异步配置
    MailerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        transport: {
          host: configService.get<string>('MAIL_HOST'),
          port: Number(configService.get<string>('MAIL_PORT')),
          secure: configService.get<string>('MAIL_SECURE') === 'true',
          auth: {
            user: configService.get<string>('MAIL_USER'),
            pass: configService.get<string>('MAIL_PASS'),
          },
        },
        defaults: {
          // 默认发件人显示名称
          from: configService.get<string>('MAIL_FROM'),
        },
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'mysql',
        host: configService.get<string>('DB_HOST'),
        port: Number(configService.get<string>('DB_PORT')),
        username: configService.get<string>('DB_USER'),
        password: configService.get<string>('DB_PASS'),
        database: configService.get<string>('DB_NAME'),
        connectorPackage: 'mysql2',
        entities: [
          User,
          AuthSession,
          Job,
          OssFile,
          VideoSession,
          VideoTask,
          VideoGenerationPlan,
          VideoMessage,
          VideoAsset,
          VideoScript,
          AgentRun,
          ToolInvocation,
        ],
        synchronize: configService.get<string>('DB_SYNCHRONIZE') === 'true',
        migrations: [join(__dirname, 'database/migrations/*{.js,.ts}')],
        migrationsRun: configService.get<string>('RUN_MIGRATIONS') === 'true',
        logging: true,
      }),
    }),
    EventEmitterModule.forRoot({
      maxListeners: 200,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL');
        const parsedUrl = redisUrl ? new URL(redisUrl) : undefined;
        const redis = {
          host:
            parsedUrl?.hostname ||
            configService.get<string>('REDIS_HOST') ||
            'localhost',
          port: parsedUrl?.port
            ? Number(parsedUrl.port)
            : Number(configService.get<string>('REDIS_PORT') || 6379),
          password: parsedUrl?.password
            ? decodeURIComponent(parsedUrl.password)
            : configService.get<string>('REDIS_PASSWORD') || undefined,
          db:
            parsedUrl?.pathname && parsedUrl.pathname !== '/'
              ? Number(parsedUrl.pathname.slice(1))
              : undefined,
          tls: parsedUrl?.protocol === 'rediss:' ? {} : undefined,
          enableReadyCheck: false,
          maxRetriesPerRequest: null,
        };
        return {
          redis,
        };
      },
    }),
    UsersModule,
    ScheduleModule.forRoot(),
    JobModule,
    ToolModule,
    SpeechModule,
    OssModule,
    VideoModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
