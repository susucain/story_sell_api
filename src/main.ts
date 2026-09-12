import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { WebSocketServer } from 'ws';
import { TtsRelayService } from './speech/tts-relay.service';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const corsOrigins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // 启用应用关闭钩子，确保在应用关闭时执行清理操作
  app.enableShutdownHooks();
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
    }),
  );
  const ttsRelayService = app.get(TtsRelayService);
  const server = app.getHttpServer();
  const wss = new WebSocketServer({ server, path: '/speech/tts/ws' });

  app.enableCors({
    credentials: true,
    origin: corsOrigins,
  });

  wss.on('connection', (socket, request) => {
    const reqUrl = new URL(request.url ?? '', 'http://localhost');
    const wantedSessionId = reqUrl.searchParams.get('sessionId') ?? undefined;
    const sessionId = ttsRelayService.registerClient(socket, wantedSessionId);

    socket.on('close', () => {
      ttsRelayService.unregisterClient(sessionId);
    });
  });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
