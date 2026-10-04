import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Index('IDX_users_account', ['account'], { unique: true })
@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    length: 50,
    nullable: true,
  })
  name: string;

  @Column({
    length: 50,
    nullable: true,
  })
  email: string;

  @Column({ length: 64, nullable: true })
  account: string;

  @Column({ name: 'password_hash', length: 255, nullable: true })
  passwordHash: string;

  @Column({ name: 'token_version', type: 'int', default: 0 })
  tokenVersion: number;

  @Column({ name: 'douyin_openid', length: 128, nullable: true, unique: true })
  douyinOpenid: string;

  @Column({ name: 'douyin_unionid', length: 128, nullable: true, unique: true })
  douyinUnionid: string;

  @Column({ length: 128, nullable: true })
  nickname: string;

  @Column({ name: 'avatar_url', type: 'text', nullable: true })
  avatarUrl: string;

  @Column({ length: 32, default: 'active' })
  status: string;

  @Column({ name: 'last_login_at', type: 'datetime', nullable: true })
  lastLoginAt: Date;

  @CreateDateColumn({
    type: 'timestamp',
    name: 'created_at',
  })
  createdAt: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    name: 'updated_at',
  })
  updatedAt: Date;
}
