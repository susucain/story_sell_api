import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { VideoTaskService } from './video-task.service';

@Processor('video-tasks')
export class VideoPersistenceProcessor {
  constructor(private readonly videoTaskService: VideoTaskService) {}

  @Process('persist-generated-video')
  async persistGeneratedVideo(job: Job<{ taskId: string }>) {
    try {
      await this.videoTaskService.persistGeneratedVideo(job.data.taskId);
    } catch (error) {
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade + 1 >= attempts) {
        await this.videoTaskService.markVideoPersistenceFailed(
          job.data.taskId,
          error,
        );
      }
      throw error;
    }
  }
}
