import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { AgentRun, AgentRunStatus } from './entities/agent-run.entity';
import { AgentRunService, RUN_STALE_HEARTBEAT_MS } from './agent-run.service';
import { ToolLedgerService } from './tool-ledger.service';

/** 清扫周期 */
const SWEEP_INTERVAL_MS = 30_000;
/** 终态 run 的保留时长 */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 保留期清理周期 */
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** 单次清理上限，避免一次删除过多 */
const RETENTION_BATCH = 500;

/**
 * run 自愈：发现「进程被杀后遗留的孤儿 run」并按台账对账收尾。
 *
 * 判定标准：DB 中 status='running'，但既不在本进程注册表里，心跳也已陈旧。
 * 因为执行发生在进程内，所以只要本进程没在跑它，就一定是孤儿（单实例部署前提；
 * 多实例需改为带实例标识的心跳，属 Phase 4）。
 */
@Injectable()
export class RunMaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RunMaintenanceService.name);
  private sweeping = false;

  constructor(
    private readonly runService: AgentRunService,
    private readonly ledger: ToolLedgerService,
    @InjectRepository(AgentRun)
    private readonly runRepo: Repository<AgentRun>,
  ) {}

  /** 启动即对账：进程重启后，上一世代遗留的在途 run 都在这里被收尾 */
  onApplicationBootstrap(): void {
    void this.reconcileStaleRuns();
  }

  @Interval(SWEEP_INTERVAL_MS)
  async sweep(): Promise<void> {
    await this.reconcileStaleRuns();
  }

  /**
   * 扫描并收尾孤儿 run。返回本次对账的条数。
   * 有交付物（台账里有终结工具成功记录）判 succeeded，否则判 failed。
   */
  async reconcileStaleRuns(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const activeIds = this.runService.collectActiveRunIds();
      const cutoff = Date.now() - RUN_STALE_HEARTBEAT_MS;
      const running = await this.runRepo.find({ where: { status: 'running' } });

      let reconciled = 0;
      for (const row of running) {
        if (activeIds.has(row.runId)) continue;
        const heartbeat = row.heartbeatAt ? row.heartbeatAt.getTime() : 0;
        if (heartbeat >= cutoff) continue;

        const succeeded = await this.ledger
          .hasTerminalSuccess(row.runId)
          .catch(() => false);
        await this.finalizeOrphan(row.runId, succeeded);
        reconciled += 1;
      }
      return reconciled;
    } catch (error: unknown) {
      this.logger.warn(
        JSON.stringify({
          event: 'run_sweep_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return 0;
    } finally {
      this.sweeping = false;
    }
  }

  /** 归档清理：删除终态超过保留期的 run 及其台账 */
  @Interval(RETENTION_INTERVAL_MS)
  async cleanupExpiredRuns(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const expired = await this.runRepo.find({
      where: {
        status: In<AgentRunStatus>(['succeeded', 'failed', 'cancelled']),
        finishedAt: LessThan(cutoff),
      },
      order: { finishedAt: 'ASC' },
      take: RETENTION_BATCH,
    });
    if (expired.length === 0) return 0;

    const runIds = expired.map((run) => run.runId);
    await this.ledger.deleteByRunIds(runIds);
    await this.runRepo.delete({ runId: In(runIds) });
    this.logger.log(
      JSON.stringify({ event: 'run_retention_cleaned', count: runIds.length }),
    );
    return runIds.length;
  }

  private async finalizeOrphan(
    runId: string,
    succeeded: boolean,
  ): Promise<void> {
    const status: AgentRunStatus = succeeded ? 'succeeded' : 'failed';
    await this.runRepo.update(
      { runId },
      {
        status,
        errorCode: succeeded ? 'RUN_RECOVERED' : 'RUN_ORPHANED',
        finishedAt: new Date(),
        // 释放会话互斥键，避免会话被僵尸 run 永久锁死
        runningKey: null,
      },
    );
    this.logger.log(JSON.stringify({ event: 'run_reconciled', runId, status }));
  }
}
