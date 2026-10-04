import { Module, forwardRef } from '@nestjs/common';
import { ToolService } from './tool.service';
import { ToolController } from './tool.controller';
import { LLMService } from './llm.service';
import { SendMailService } from './send-mail.service';
import { WebSearchService } from './web-search.service';
import { DbUsersCrudService } from './db-users-crud.service';
import { CronJobService } from './cron-job.service';
import { UsersModule } from '../users/users.module';
import { JobModule } from '../job/job.module';
import { TimeNowToolService } from './time-now-tool.service';

@Module({
  controllers: [ToolController],
  imports: [UsersModule, forwardRef(() => JobModule)],
  providers: [
    ToolService,
    LLMService,
    SendMailService,
    WebSearchService,
    DbUsersCrudService,
    CronJobService,
    TimeNowToolService,
    {
      provide: 'CHAT_MODEL',
      useFactory: (llmService: LLMService) => llmService.getModel(),
      inject: [LLMService],
    },
    {
      provide: 'SEND_MAIL_TOOL',
      useFactory: (sendMailService: SendMailService) => sendMailService.tool,
      inject: [SendMailService],
    },
    {
      provide: 'WEB_SEARCH_TOOL',
      useFactory: (webSearchService: WebSearchService) => webSearchService.tool,
      inject: [WebSearchService],
    },
    {
      provide: 'DB_USERS_CRUD_TOOL',
      useFactory: (dbUsersCrudService: DbUsersCrudService) =>
        dbUsersCrudService.tool,
      inject: [DbUsersCrudService],
    },
    {
      provide: 'CRON_JOB_TOOL',
      useFactory: (cronJobService: CronJobService) => cronJobService.tool,
      inject: [CronJobService],
    },
    {
      provide: 'TIME_NOW_TOOL',
      useFactory: (timeNowToolService: TimeNowToolService) =>
        timeNowToolService.tool,
      inject: [TimeNowToolService],
    },
  ],
  exports: [
    'CHAT_MODEL',
    'SEND_MAIL_TOOL',
    'WEB_SEARCH_TOOL',
    'DB_USERS_CRUD_TOOL',
    'CRON_JOB_TOOL',
    'TIME_NOW_TOOL',
  ],
})
export class ToolModule {}
