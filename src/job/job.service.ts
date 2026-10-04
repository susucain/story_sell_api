import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { EntityManager } from 'typeorm';
import { Job } from './entities/job.entity';
import { JobAgentService } from '../ai/job-agent.service';

@Injectable()
export class JobService implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobService.name);

  constructor(
    private readonly entityManager: EntityManager,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly jobAgentService: JobAgentService,
  ) {}

  // 初始化时注册所有启用的任务定时器（nest内部生命周期钩子）
  async onApplicationBootstrap() {
    const enabledJobs = await this.entityManager.find(Job, {
      where: { isEnabled: true },
    });
    const cronJobs = this.schedulerRegistry.getCronJobs();
    const intervals = this.schedulerRegistry.getIntervals();
    const timeouts = this.schedulerRegistry.getTimeouts();

    for (const job of enabledJobs) {
      const alreadyRegistered =
        (job.type === 'cron' && cronJobs.has(job.id)) ||
        (job.type === 'every' && intervals.includes(job.id)) ||
        (job.type === 'at' && timeouts.includes(job.id));
      if (alreadyRegistered) continue;

      await this.startRuntime(job);
    }
  }

  async listJobs() {
    const jobs = await this.entityManager.find(Job, {
      order: { createdAt: 'DESC' },
    });

    const cronJobs = this.schedulerRegistry.getCronJobs();
    const intervalNames = this.schedulerRegistry.getIntervals();
    const timeoutNames = this.schedulerRegistry.getTimeouts();

    return jobs.map((job) => {
      const running =
        job.isEnabled &&
        ((job.type === 'cron' && cronJobs.has(job.id)) ||
          (job.type === 'every' && intervalNames.includes(job.id)) ||
          (job.type === 'at' && timeoutNames.includes(job.id)));

      return {
        ...job,
        running,
      };
    });
  }

  async addJob(
    input:
      | {
          type: 'cron';
          instruction: string;
          cron: string;
          isEnabled?: boolean;
        }
      | {
          type: 'every';
          instruction: string;
          everyMs: number;
          isEnabled?: boolean;
        }
      | {
          type: 'at';
          instruction: string;
          at: Date;
          isEnabled?: boolean;
        },
  ) {
    const entity = this.entityManager.create(Job, {
      instruction: input.instruction,
      type: input.type,
      cron: input.type === 'cron' ? input.cron : null,
      everyMs: input.type === 'every' ? input.everyMs : null,
      at: input.type === 'at' ? input.at : null,
      isEnabled: input.isEnabled ?? true,
      lastRun: null,
    });

    const saved = await this.entityManager.save(Job, entity);

    if (saved.isEnabled) {
      await this.startRuntime(saved);
    }

    return saved;
  }

  async toggleJob(jobId: string, enabled?: boolean) {
    const job = await this.entityManager.findOne(Job, { where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job not found: ${jobId}`);

    const nextEnabled = enabled ?? !job.isEnabled;
    if (job.isEnabled !== nextEnabled) {
      job.isEnabled = nextEnabled;
      await this.entityManager.save(Job, job);
    }

    if (job.isEnabled) {
      await this.startRuntime(job);
    } else {
      this.stopRuntime(job);
    }

    return job;
  }

  private async startRuntime(job: Job) {
    if (job.type === 'cron') {
      const cronJobs = this.schedulerRegistry.getCronJobs();
      const existing = cronJobs.get(job.id);
      if (existing) {
        existing.start();
        return;
      }

      const runtimeJob = this.createCronJob(job);
      this.schedulerRegistry.addCronJob(job.id, runtimeJob);
      runtimeJob.start();
      return;
    }

    if (job.type === 'every') {
      const names = this.schedulerRegistry.getIntervals();
      if (names.includes(job.id)) return;

      if (typeof job.everyMs !== 'number' || job.everyMs <= 0) {
        throw new Error(`Invalid everyMs for job ${job.id}`);
      }

      const ref = setInterval(async () => {
        this.logger.log(`run job ${job.id}, ${job.instruction}`);
        await this.entityManager.update(Job, job.id, { lastRun: new Date() });

        // 如果promat是在十分钟后去发送一份邮件，那在十分钟之后还需要调用大模型
        try {
          await this.jobAgentService.runJob(job.instruction);
        } catch (e) {
          this.logger.error(`job ${job.id} failed`, e);
        }
      }, job.everyMs);

      this.schedulerRegistry.addInterval(job.id, ref);
      return;
    }

    if (job.type === 'at') {
      const names = this.schedulerRegistry.getTimeouts();
      if (names.includes(job.id)) return;

      if (!job.at) {
        throw new Error(`Invalid at for job ${job.id}`);
      }

      const delay = Math.max(0, job.at.getTime() - Date.now());
      const ref = setTimeout(async () => {
        this.logger.log(`run job ${job.id}, ${job.instruction}`);
        await this.entityManager.update(Job, job.id, {
          lastRun: new Date(),
          isEnabled: false, // at 类型只执行一次：执行完自动停用
        });

        try {
          await this.jobAgentService.runJob(job.instruction);
        } catch (e) {
          this.logger.error(`job ${job.id} failed`, e);
        }

        try {
          this.schedulerRegistry.deleteTimeout(job.id);
        } catch {
          // ignore
        }
      }, delay);

      this.schedulerRegistry.addTimeout(job.id, ref);
      return;
    }
  }

  private stopRuntime(job: Job) {
    if (job.type === 'cron') {
      const cronJobs = this.schedulerRegistry.getCronJobs();
      const runtimeJob = cronJobs.get(job.id);
      if (runtimeJob) runtimeJob.stop();
      return;
    }

    if (job.type === 'every') {
      try {
        this.schedulerRegistry.deleteInterval(job.id);
      } catch {
        // ignore
      }
      return;
    }

    if (job.type === 'at') {
      try {
        this.schedulerRegistry.deleteTimeout(job.id);
      } catch {
        // ignore
      }
      return;
    }
  }

  private createCronJob(job: Job) {
    const cronExpr = job.cron ?? '';
    return new CronJob(cronExpr, async () => {
      try {
        this.logger.log(`run job ${job.id}, ${job.instruction}`);
        await this.entityManager.update(Job, job.id, { lastRun: new Date() });

        // 如果promat是在十分钟后去发送一份邮件，那在十分钟之后还需要调用大模型
        try {
          await this.jobAgentService.runJob(job.instruction);
        } catch (e) {
          this.logger.error(`job ${job.id} failed`, e);
        }
      } catch (e) {
        this.logger.error(`job ${job.id} failed`, e);
      }
    });
  }
}
