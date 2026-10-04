import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { hostname } from 'node:os';
import { AgentRun, AgentRunStatus } from './entities/agent-run.entity';
import { RunCancelService } from './run-cancel.service';

/** 心跳写入间隔：进程存活期间周期性刷新 heartbeat_at */
export const RUN_HEARTBEAT_INTERVAL_MS = 10_000;

/** 心跳超过该时长未刷新即认为执行进程已死 */
export const RUN_STALE_HEARTBEAT_MS = 60_000;

/** 客户端断开导致的中止（Phase 1 仍沿用中止语义，Phase 2 会改为仅解绑订阅） */
export const RUN_REASON_CLIENT_DISCONNECTED = 'client_disconnected';
/** 用户主动取消 */
export const RUN_REASON_USER_CANCELLED = 'user_cancelled';
/** 超过总预算被回收 */
export const RUN_REASON_BUDGET_EXCEEDED = 'VIDEO_AGENT_TOTAL_TIMEOUT';

/**
 * 一条进行中的运行。
 *
 * 关键点：它持有自己的 AbortController —— 中止信号的主人是 run，而不是那次
 * HTTP 请求。这样「谁能让这轮停下来」就收敛成了显式的 cancel 调用。
 */
export interface ActiveAgentRun {
  runId: string;
  sessionId: string;
  userId: number;
  controller: AbortController;
  signal: AbortSignal;
  startedAt: Date;
  /** 首个错误码，用于决定最终状态 */
  errorCode: string | null;
  /** 保证只收尾一次 */
  settled: boolean;
}

/** 识别 MySQL 唯一键冲突（running_key 被占用） */
function isDuplicateKeyError(error: unknown): boolean {
  const driverError = (
    error as { driverError?: { code?: string; errno?: number } }
  )?.driverError;
  return driverError?.code === 'ER_DUP_ENTRY' || driverError?.errno === 1062;
}

/**
 * Agent 运行的生命周期管理。
 *
 * 产品约定：一个会话同一时刻只允许一条进行中的链路，因此取消入口按
 * sessionId 定位（`POST /video/chat/cancel`）。会话互斥由 DB 唯一约束
 * （`running_key`）保证，取消则通过跨实例广播 + 持久标记生效。
 */
@Injectable()
export class AgentRunService implements OnModuleInit {
  private readonly logger = new Logger(AgentRunService.name);
  /** sessionId -> 进行中的运行 */
  private readonly active = new Map<string, ActiveAgentRun>();
  /** 本进程标识，写入 agent_runs 便于多实例排障 */
  private readonly instanceId =
    process.env.INSTANCE_ID || `${hostname()}:${process.pid}`;

  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepo: Repository<AgentRun>,
    private readonly cancelBus: RunCancelService,
  ) {}

  onModuleInit(): void {
    // 别的实例收到取消请求后会广播 runId，这里负责中止本进程持有的 run
    this.cancelBus.onCancel((runId) => this.abortByRunId(runId));
  }

  getActive(sessionId: string): ActiveAgentRun | undefined {
    return this.active.get(sessionId);
  }

  /**
   * 查会话在途的 run（读 DB，任意实例都能答）。
   * 只认心跳新鲜的记录，避免把崩溃遗留的僵尸 run 当成「仍在进行」。
   */
  async findRunningBySession(sessionId: string): Promise<AgentRun | null> {
    const cutoff = new Date(Date.now() - RUN_STALE_HEARTBEAT_MS);
    return this.runRepo.findOne({
      where: {
        sessionId,
        status: 'running',
        heartbeatAt: MoreThanOrEqual(cutoff),
      },
      order: { startedAt: 'DESC' },
    });
  }

  /** 按 runId 中止本进程持有的 run（跨实例取消的落点） */
  abortByRunId(runId: string, reason = RUN_REASON_USER_CANCELLED): void {
    for (const run of this.active.values()) {
      if (run.runId !== runId) continue;
      this.markError(run, reason);
      if (!run.controller.signal.aborted) {
        run.controller.abort(new Error(reason));
      }
      return;
    }
  }

  /** 按 runId 查运行记录（含已收尾的），用于事件端点的归属校验。 */
  async findByRunId(runId: string): Promise<AgentRun | null> {
    return this.runRepo.findOne({ where: { runId } });
  }

  /** 当前进程内仍在推进的 runId 集合（清扫器据此区分「本进程在跑」与「孤儿」） */
  collectActiveRunIds(): Set<string> {
    return new Set([...this.active.values()].map((run) => run.runId));
  }

  /**
   * 周期性刷新活跃 run 的心跳。进程被杀后心跳停止推进，清扫器即依据
   * 「running 且心跳陈旧且不在本进程注册表」判定为孤儿。
   */
  @Interval(RUN_HEARTBEAT_INTERVAL_MS)
  async heartbeat(): Promise<void> {
    if (this.active.size === 0) return;
    const runIds = [...this.active.values()].map((run) => run.runId);
    try {
      await this.runRepo.update(
        { runId: In(runIds) },
        { heartbeatAt: new Date() },
      );
      // 兜底：pub/sub 若丢失，跨实例取消标记最迟在这里被发现
      const flagged = await this.runRepo.find({
        where: { runId: In(runIds), cancelRequestedAt: Not(IsNull()) },
        select: { runId: true },
      });
      for (const row of flagged) {
        this.abortByRunId(row.runId);
      }
    } catch (error: unknown) {
      this.logger.warn(
        JSON.stringify({
          event: 'run_heartbeat_failed',
          runIds,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * 开启一条运行；同会话已有进行中的链路时抛 409。
   */
  async startRun(sessionId: string, userId: number): Promise<ActiveAgentRun> {
    if (this.active.has(sessionId)) {
      throw new ConflictException('当前会话已有正在进行的生成，请先停止后再试');
    }

    const controller = new AbortController();
    const run: ActiveAgentRun = {
      runId: randomUUID(),
      sessionId,
      userId,
      controller,
      signal: controller.signal,
      startedAt: new Date(),
      errorCode: null,
      settled: false,
    };
    this.active.set(sessionId, run);

    try {
      await this.runRepo.save(
        this.runRepo.create({
          runId: run.runId,
          sessionId,
          userId,
          status: 'running',
          startedAt: run.startedAt,
          heartbeatAt: run.startedAt,
          instanceId: this.instanceId,
          // running_key 唯一约束是跨实例会话互斥的最终保证
          runningKey: sessionId,
        }),
      );
    } catch (error: unknown) {
      // 落库失败就不能把会话卡在「进行中」
      this.active.delete(sessionId);
      if (isDuplicateKeyError(error)) {
        throw new ConflictException(
          '当前会话已有正在进行的生成，请先停止后再试',
        );
      }
      throw error;
    }

    this.logger.log(
      JSON.stringify({ event: 'run_started', runId: run.runId, sessionId }),
    );
    return run;
  }

  /** 记录首个错误码，用于收尾时判定 succeeded / failed / cancelled */
  markError(run: ActiveAgentRun, errorCode: string): void {
    if (!run.errorCode) {
      run.errorCode = errorCode;
    }
  }

  /**
   * 取消某会话进行中的链路。返回是否真的取消了一条。
   * 传入 userId 时会校验归属，避免跨用户取消。
   */
  async cancel(
    sessionId: string,
    userId?: number,
    reason = RUN_REASON_USER_CANCELLED,
  ): Promise<boolean> {
    // 快路径：run 就在本进程
    const run = this.getActive(sessionId);
    if (run) {
      if (userId !== undefined && run.userId !== userId) return false;
      this.markError(run, reason);
      if (!run.controller.signal.aborted) {
        run.controller.abort(new Error(reason));
      }
      return true;
    }

    // 慢路径：run 在别的实例上 —— 写持久标记 + 广播，由持有者中止
    const row = await this.runRepo.findOne({
      where: { sessionId, status: 'running' },
    });
    if (!row) return false;
    if (userId !== undefined && row.userId !== userId) return false;

    await this.runRepo.update(
      { runId: row.runId },
      { cancelRequestedAt: new Date() },
    );
    await this.cancelBus.publishCancel(row.runId);
    return true;
  }

  /**
   * 收尾一条运行：落状态、释放注册表。幂等。
   */
  async finalize(run: ActiveAgentRun): Promise<void> {
    if (run.settled) return;
    run.settled = true;

    const status: AgentRunStatus = run.controller.signal.aborted
      ? 'cancelled'
      : run.errorCode
        ? 'failed'
        : 'succeeded';

    if (this.active.get(run.sessionId)?.runId === run.runId) {
      this.active.delete(run.sessionId);
    }

    try {
      await this.runRepo.update(
        { runId: run.runId },
        {
          status,
          errorCode: run.errorCode,
          finishedAt: new Date(),
          // 释放会话互斥键，允许该会话开启下一条链路
          runningKey: null,
        },
      );
    } catch (error: unknown) {
      this.logger.error(
        JSON.stringify({
          event: 'run_finalize_failed',
          runId: run.runId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    this.logger.log(
      JSON.stringify({
        event: 'run_finished',
        runId: run.runId,
        sessionId: run.sessionId,
        status,
        errorCode: run.errorCode,
      }),
    );
  }

  /**
   * 独立消费一条 SSE 流直到结束，然后收尾运行。
   *
   * 之所以要单独消费：pipe 给响应的那一路会随客户端断开而停止，而 run 的推进
   * 不应该依赖它。这里持续读走数据，既避免上游因背压卡死，也拿到了收尾时机。
   */
  async watchStream(
    run: ActiveAgentRun,
    stream: ReadableStream<string>,
  ): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // 流异常/客户端断开：状态已由 markError 记录，这里只负责收尾
    } finally {
      reader.releaseLock();
      await this.finalize(run);
    }
  }
}
