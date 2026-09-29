import { Module } from '@nestjs/common';
import { VideoService } from './video.service';
import { VideoTaskService } from './video-task.service';
import { VideoController } from './video.controller';
import { ToolModule } from '../tool/tool.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VideoSession } from './entities/video-session.entity';
import { VideoTask } from './entities/video-task.entity';
import { VideoMessage } from './entities/video-message.entity';
import { VideoAsset } from './entities/video-asset.entity';
import { VideoScript } from './entities/video-script.entity';
import { VideoLLMService } from './video-llm.service';
import { SkillLoaderService } from './skill-loader.service';
import { AgentRoleRegistryService } from './agent-role.registry';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { StoryboardParserService } from './storyboard-parser.service';
import { VideoToolsService } from './video-tools.service';
import { VideoPersistenceProcessor } from './video-persistence.processor';
import { SeedancePromptValidatorService } from './seedance-prompt-validator.service';
import { VideoAgentExecutionService } from './video-agent-execution.service';
import { VideoAssetAnalysisService } from './video-asset-analysis.service';
import { BullModule } from '@nestjs/bull';
import { OssModule } from '../oss/oss.module';

@Module({
  controllers: [VideoController],
  providers: [
    VideoService,
    VideoTaskService,
    VideoLLMService,
    SkillLoaderService,
    AgentRoleRegistryService,
    AgentOrchestratorService,
    StoryboardParserService,
    VideoToolsService,
    VideoPersistenceProcessor,
    SeedancePromptValidatorService,
    VideoAgentExecutionService,
    VideoAssetAnalysisService,
  ],
  imports: [
    ToolModule,
    OssModule,
    TypeOrmModule.forFeature([
      VideoSession,
      VideoTask,
      VideoMessage,
      VideoAsset,
      VideoScript,
    ]),
    BullModule.registerQueue({
      name: 'video-tasks',
    }),
  ],
})
export class VideoModule {}
