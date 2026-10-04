import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import { ToolInvocation } from './entities/tool-invocation.entity';

/** 会改动数据的工具；只有这些需要进台账供崩溃后对账 */
const SIDE_EFFECT_TOOLS = new Set([
  'generate_script',
  'create_video_task',
  'update_creative_brief',
  'write_file',
]);

/** 能代表「本轮已产出交付物」的终结工具；对账据此判定 succeeded */
const TERMINAL_TOOLS = ['generate_script', 'create_video_task'];

export function isSideEffectTool(toolName: string): boolean {
  return SIDE_EFFECT_TOOLS.has(toolName);
}

/** 稳定序列化：对象键排序后生成的 JSON 才可跨进程得到同一哈希 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

export function hashToolArgs(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(input) ?? null))
    .digest('hex');
}

/**
 * 副作用工具调用台账。
 *
 * 写入是「尽力而为」：台账失败不能影响创作主链路，因此所有异常只记日志。
 * 读取只服务于崩溃对账（判断孤儿 run 是否已产出交付物）。
 */
@Injectable()
export class ToolLedgerService {
  private readonly logger = new Logger(ToolLedgerService.name);

  constructor(
    @InjectRepository(ToolInvocation)
    private readonly repo: Repository<ToolInvocation>,
  ) {}

  async recordSuccess(
    runId: string,
    tool: string,
    input: unknown,
    resultRef?: string,
  ): Promise<void> {
    await this.record(runId, tool, input, 'succeeded', resultRef);
  }

  async recordFailure(
    runId: string,
    tool: string,
    input: unknown,
  ): Promise<void> {
    await this.record(runId, tool, input, 'failed');
  }

  /** 该 run 是否已成功调用过终结工具（存在即认为交付物已产出） */
  async hasTerminalSuccess(runId: string): Promise<boolean> {
    const count = await this.repo.count({
      where: { runId, tool: In(TERMINAL_TOOLS), status: 'succeeded' },
    });
    return count > 0;
  }

  async deleteByRunIds(runIds: string[]): Promise<void> {
    if (runIds.length === 0) return;
    await this.repo.delete({ runId: In(runIds) });
  }

  private async record(
    runId: string,
    tool: string,
    input: unknown,
    status: 'succeeded' | 'failed',
    resultRef?: string,
  ): Promise<void> {
    const argsHash = hashToolArgs(input);
    try {
      const existing = await this.repo.findOne({
        where: { runId, tool, argsHash },
      });
      if (existing) {
        await this.repo.update(existing.id, {
          status,
          resultRef: resultRef ?? existing.resultRef,
        });
        return;
      }
      const stepIndex = await this.repo.count({ where: { runId } });
      await this.repo.save(
        this.repo.create({
          runId,
          tool,
          argsHash,
          stepIndex,
          status,
          resultRef: resultRef ?? null,
        }),
      );
    } catch (error: unknown) {
      this.logger.warn(
        JSON.stringify({
          event: 'tool_ledger_write_failed',
          runId,
          tool,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
