import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** Agent 运行（一次提问触发的一条执行链路）的整体状态 */
export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * Agent 运行记录。
 *
 * 目的是把「执行生命周期」从「HTTP 连接生命周期」里解耦出来：
 * - 一个会话同一时刻只允许一条进行中的链路（由 AgentRunService 的注册表守卫）；
 * - 取消按 sessionId 定位，而不是依赖客户端断开连接。
 *
 * 只记录运行元数据，不承载任何创作内容（内容分别落在 video_messages /
 * video_scripts 等表，符合「数据库只存消息元数据」的既有约束）。
 */
@Entity('agent_runs')
@Index(['sessionId'])
@Index('IDX_agent_runs_running_key', ['runningKey'], { unique: true })
export class AgentRun {
  @PrimaryGeneratedColumn({ comment: '主键ID' })
  id: number;

  @Column({
    name: 'run_id',
    length: 64,
    unique: true,
    comment: '对外运行标识（UUID）',
  })
  runId: string;

  @Column({ name: 'session_id', length: 64, comment: '关联会话ID' })
  sessionId: string;

  @Column({ name: 'user_id', comment: '关联用户ID' })
  userId: number;

  @Column({
    name: 'status',
    length: 32,
    default: 'running',
    comment: '状态: running/succeeded/failed/cancelled',
  })
  status: AgentRunStatus;

  @Column({
    name: 'error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '失败或取消的错误码',
  })
  errorCode: string | null;

  @Column({ name: 'started_at', type: 'timestamp', comment: '开始时间' })
  startedAt: Date;

  @Column({
    name: 'heartbeat_at',
    type: 'timestamp',
    nullable: true,
    comment: '最近一次心跳时间，用于识别崩溃遗留的孤儿 run',
  })
  heartbeatAt: Date | null;

  @Column({
    name: 'instance_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '执行该 run 的实例标识（多实例排障用）',
  })
  instanceId: string | null;

  @Column({
    name: 'running_key',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment:
      'running 期间等于 session_id，靠唯一约束保证跨实例「同会话至多一条链路」；终态置空',
  })
  runningKey: string | null;

  @Column({
    name: 'cancel_requested_at',
    type: 'timestamp',
    nullable: true,
    comment: '跨实例取消的持久标记（pub/sub 丢失时的兜底）',
  })
  cancelRequestedAt: Date | null;

  @Column({
    name: 'finished_at',
    type: 'timestamp',
    nullable: true,
    comment: '结束时间',
  })
  finishedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', comment: '更新时间' })
  updatedAt: Date;
}
