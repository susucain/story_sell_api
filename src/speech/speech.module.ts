import { Module } from '@nestjs/common';
import { SpeechService } from './speech.service';
import { SpeechController } from './speech.controller';
import * as tencentcloud from 'tencentcloud-sdk-nodejs';
import { ConfigService } from '@nestjs/config';
import { TtsRelayService } from './tts-relay.service';

const AsrClient = tencentcloud.asr.v20190614.Client;

@Module({
  controllers: [SpeechController],
  providers: [
    SpeechService,
    TtsRelayService,
    {
      provide: 'ASR_CLIENT',
      useFactory: (configService: ConfigService) => {
        return new AsrClient({
          credential: {
            secretId: configService.get<string>('SECRET_ID'),
            secretKey: configService.get<string>('SECRET_KEY'),
          },
          region: 'ap-shanghai',
          profile: {
            httpProfile: {
              reqMethod: 'POST',
              reqTimeout: 30,
            },
          },
        });
      },
      inject: [ConfigService],
    },
  ],
})
export class SpeechModule {}
