import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('video_message')
@Index(['sessionId', 'createdAt'])
@Index(['taskId', 'eventType'], { unique: true })
export class VideoMessage {
  @PrimaryGeneratedColumn({ comment: '主键ID' })
  id: number;

  @Column({ name: 'session_id', length: 64, comment: '关联会话ID' })
  sessionId: string;

  @Column({ name: 'user_id', comment: '关联用户ID' })
  userId: number;

  @Column({ name: 'role', length: 32, comment: '消息角色：user / assistant' })
  role: string;

  @Column({
    name: 'content',
    type: 'text',
    nullable: true,
    comment: '消息文本内容',
  })
  content: string;

  @Column({
    name: 'parts',
    type: 'json',
    nullable: true,
    comment: '用户消息内容块（含附件）',
  })
  parts: Record<string, any>[];

  @Column({
    name: 'tool_calls',
    type: 'json',
    nullable: true,
    comment: '工具调用元数据摘要',
  })
  toolCalls: Record<string, any>;

  @Column({
    name: 'metadata',
    type: 'json',
    nullable: true,
    comment: '消息元数据（如生成脚本的 script_id）',
  })
  metadata: Record<string, any>;

  @Column({
    name: 'task_id',
    type: 'varchar',
    length: 128,
    nullable: true,
    comment: '关联视频任务ID',
  })
  taskId: string;

  @Column({
    name: 'event_type',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '系统事件类型',
  })
  eventType: string;

  @CreateDateColumn({ name: 'created_at', comment: '创建时间' })
  createdAt: Date;
}
