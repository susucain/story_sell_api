import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('video_scripts')
@Index(['sessionId', 'version'])
export class VideoScript {
  @PrimaryGeneratedColumn({ comment: '主键ID' })
  id: number;

  @Column({ name: 'session_id', length: 64, comment: '关联会话ID' })
  sessionId: string;

  @Column({ name: 'user_id', comment: '关联用户ID' })
  userId: number;

  @Column({ name: 'version', comment: '版本号' })
  version: number;

  @Column({ name: 'title', length: 256, comment: '脚本标题' })
  title: string;

  @Column({
    name: 'hook',
    type: 'text',
    nullable: true,
    comment: '开头吸引点描述',
  })
  hook: string;

  @Column({ name: 'shots', type: 'json', comment: '结构化分镜数组' })
  shots: any[];

  @Column({
    name: 'script_markdown',
    type: 'text',
    comment: '易读Markdown脚本',
  })
  scriptMarkdown: string;

  @Column({
    name: 'seedance_prompt',
    type: 'text',
    comment: 'Seedance 2.0提示词',
  })
  seedancePrompt: string;

  @Column({ name: 'meta', type: 'json', nullable: true, comment: '元信息' })
  meta: Record<string, any>;

  @Column({
    name: 'source_message_id',
    nullable: true,
    comment: '触发生成的消息ID',
  })
  sourceMessageId: number;

  @Column({
    name: 'based_on_version',
    nullable: true,
    comment: '基于哪个版本修改',
  })
  basedOnVersion: number;

  @Column({
    name: 'status',
    length: 32,
    default: 'draft',
    comment: '状态：draft / confirmed / used_for_video',
  })
  status: string;

  @CreateDateColumn({ name: 'created_at', comment: '创建时间' })
  createdAt: Date;
}
