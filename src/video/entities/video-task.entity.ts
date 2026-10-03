import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('video_tasks')
@Index(['sessionId'])
export class VideoTask {
  @PrimaryGeneratedColumn({ comment: '主键ID' })
  id: number;

  @Column({ name: 'session_id', length: 64, comment: '关联会话ID' })
  sessionId: string;

  @Column({ name: 'user_id', comment: '关联用户ID' })
  userId: number;

  @Column({ name: 'script_id', nullable: true, comment: '关联脚本版本ID' })
  scriptId: number;

  @Column({ name: 'task_id', length: 128, unique: true, comment: '火山引擎任务ID' })
  taskId: string;

  @Column({ name: 'model', length: 128, comment: '使用的模型' })
  model: string;

  @Column({ name: 'status', length: 32, default: 'queued', comment: '任务状态: queued/running/persisting/succeeded/failed/expired/cancelled' })
  status: string;

  @Column({ name: 'prompt', type: 'text', nullable: true, comment: '提示词' })
  prompt: string;

  @Column({ name: 'image_urls', type: 'text', nullable: true, comment: '参考图片URL列表（JSON数组）' })
  imageUrls: string;

  @Column({ name: 'video_urls', type: 'text', nullable: true, comment: '参考视频URL列表（JSON数组）' })
  videoUrls: string;

  @Column({ name: 'generated_video_url', type: 'text', nullable: true, comment: '生成的视频URL' })
  generatedVideoUrl: string;

  @Column({ name: 'last_frame_url', type: 'text', nullable: true, comment: '尾帧图片URL' })
  lastFrameUrl: string;

  @Column({ name: 'duration', nullable: true, comment: '视频时长（秒）' })
  duration: number;

  @Column({ name: 'resolution', length: 32, nullable: true, comment: '分辨率' })
  resolution: string;

  @Column({ name: 'ratio', length: 32, nullable: true, comment: '宽高比' })
  ratio: string;

  @Index()
  @Column({ name: 'plan_id', nullable: true, comment: '关联分段生成计划ID，单段任务为空' })
  planId: number;

  @Column({ name: 'segment_index', nullable: true, comment: '所属分段序号（从1开始）' })
  segmentIndex: number;

  @Column({ name: 'prev_task_id', length: 128, nullable: true, comment: '上一段任务ID，用于续接' })
  prevTaskId: string;

  @Column({
    name: 'continuity_mode',
    length: 16,
    nullable: true,
    comment: '衔接方式: extend（延长上一段）/ frame_bridge（尾帧作首帧）',
  })
  continuityMode: string;

  @Column({ name: 'error_code', length: 128, nullable: true, comment: '错误码' })
  errorCode: string;

  @Column({ name: 'error_message', type: 'text', nullable: true, comment: '错误信息' })
  errorMessage: string;

  @Column({ name: 'volc_response', type: 'longtext', nullable: true, comment: '火山引擎完整响应（JSON）' })
  volcResponse: string;

  @CreateDateColumn({ name: 'created_at', comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', comment: '更新时间' })
  updatedAt: Date;
}
