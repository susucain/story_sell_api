import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type AssetType = 'image' | 'video' | 'url';
export type AssetPurpose = 'all' | 'analysis' | 'reference';
export type AssetContentCategory =
  | 'portrait'
  | 'product'
  | 'food'
  | 'store'
  | 'environment'
  | 'other';

@Entity('video_assets')
@Index(['sessionId'])
export class VideoAsset {
  @PrimaryGeneratedColumn({ comment: '主键ID' })
  id: number;

  @Column({ name: 'session_id', length: 64, comment: '关联会话ID' })
  sessionId: string;

  @Column({ name: 'user_id', comment: '关联用户ID' })
  userId: number;

  @Column({
    name: 'asset_type',
    length: 32,
    comment: '素材类型：image / video / url',
  })
  assetType: AssetType;

  @Column({
    name: 'asset_purpose',
    length: 32,
    default: 'all',
    comment: '素材用途：all / analysis / reference',
  })
  assetPurpose: AssetPurpose;

  @Column({
    name: 'content_category',
    length: 32,
    nullable: true,
    comment:
      '素材内容分类：portrait / product / food / store / environment / other',
  })
  contentCategory: AssetContentCategory;

  @Column({ name: 'name', length: 256, comment: '素材名称' })
  name: string;

  @Column({ name: 'url', type: 'text', comment: '素材访问URL' })
  url: string;

  @Column({
    name: 'thumbnail_url',
    type: 'text',
    nullable: true,
    comment: '缩略图URL',
  })
  thumbnailUrl: string;

  @Column({
    name: 'parsed_content',
    type: 'json',
    nullable: true,
    comment: '解析结果',
  })
  parsedContent: Record<string, any>;

  @Column({
    name: 'status',
    length: 32,
    default: 'pending',
    comment: '状态：pending / parsed / failed',
  })
  status: string;

  @CreateDateColumn({ name: 'created_at', comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', comment: '更新时间' })
  updatedAt: Date;
}
