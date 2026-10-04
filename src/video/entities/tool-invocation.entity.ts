import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

/** 一次副作用工具调用的结果 */
export type ToolInvocationStatus = 'succeeded' | 'failed';

/**
 * 副作用工具调用台账。
 *
 * 只记录会改动数据的工具（generate_script / create_video_task 等），作为
 * 「run 崩溃后判定最终态」的证据：进程被 kill 时没有机会走 finalize，清扫器
 * 只能靠这份台账判断这轮到底有没有产出交付物。
 *
 * 唯一键 (run_id, tool, args_hash) 让重复记录天然幂等，也为后续「阶段级续跑」
 * 预留了去重依据。不承载任何创作内容，只存调用元数据。
 */
@Entity('tool_invocations')
@Unique('IDX_tool_invocations_run_tool_args', ['runId', 'tool', 'argsHash'])
@Index(['runId'])
export class ToolInvocation {
  @PrimaryGeneratedColumn({ comment: '主键ID' })
  id: number;

  @Column({ name: 'run_id', length: 64, comment: '关联运行ID' })
  runId: string;

  @Column({
    name: 'step_index',
    type: 'int',
    default: 0,
    comment: '本轮内副作用调用的序号（从 0 递增）',
  })
  stepIndex: number;

  @Column({ name: 'tool', length: 64, comment: '工具名' })
  tool: string;

  @Column({
    name: 'args_hash',
    length: 64,
    comment: '规范化入参的 SHA-256',
  })
  argsHash: string;

  @Column({
    name: 'status',
    length: 16,
    comment: '状态: succeeded/failed',
  })
  status: ToolInvocationStatus;

  @Column({
    name: 'result_ref',
    type: 'varchar',
    length: 128,
    nullable: true,
    comment: '产出物引用（如脚本ID、视频任务ID）',
  })
  resultRef: string | null;

  @CreateDateColumn({ name: 'created_at', comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', comment: '更新时间' })
  updatedAt: Date;
}
