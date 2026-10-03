import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** 分段视频生成计划的整体状态 */
export type VideoGenerationPlanStatus =
  | 'planning'
  | 'generating'
  | 'awaiting_confirm'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 段与段的衔接方式：延长上一段视频 / 上一段尾帧作本段首帧 */
export type VideoContinuityMode = 'extend' | 'frame_bridge';

/** 引用已生成视频时的意图：编辑原片 / 基于原片续写 */
export type VideoSourceIntent = 'edit' | 'continue';

/**
 * 脚本 meta.continuation：基于已生成视频续写新剧情。
 * 与 meta.edit 互斥；续写脚本的时长取脚本自身，不锁原片时长。
 */
export interface ContinuationMeta {
  mode: 'continuation';
  /** 被续写的原片素材 ID */
  sourceAssetId: number;
  /** 原片时长（秒），用于校验与展示 */
  sourceDurationSec: number;
  /** 首段与原片的衔接方式 */
  continuityMode: VideoContinuityMode;
}

@Entity('video_generation_plans')
@Index(['sessionId'])
export class VideoGenerationPlan {
  @PrimaryGeneratedColumn({ comment: '主键ID' })
  id: number;

  @Column({ name: 'session_id', length: 64, comment: '关联会话ID' })
  sessionId: string;

  @Column({ name: 'user_id', comment: '关联用户ID' })
  userId: number;

  @Column({ name: 'script_id', comment: '关联脚本版本ID' })
  scriptId: number;

  @Column({ name: 'target_duration', comment: '脚本总时长（秒）' })
  targetDuration: number;

  @Column({
    name: 'segment_duration',
    default: 15,
    comment: '单段生成时长上限（秒）',
  })
  segmentDuration: number;

  @Column({ name: 'total_segments', comment: '规划出的总段数' })
  totalSegments: number;

  @Column({
    name: 'completed_segments',
    default: 0,
    comment: '已生成成功的段数',
  })
  completedSegments: number;

  @Column({
    name: 'status',
    length: 32,
    default: 'planning',
    comment:
      '状态: planning/generating/awaiting_confirm/completed/failed/cancelled',
  })
  status: VideoGenerationPlanStatus;

  @Column({
    name: 'assembled_video_url',
    type: 'text',
    nullable: true,
    comment: '二期拼接成片地址（本期不写入）',
  })
  assembledVideoUrl: string;

  @CreateDateColumn({ name: 'created_at', comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', comment: '更新时间' })
  updatedAt: Date;
}
