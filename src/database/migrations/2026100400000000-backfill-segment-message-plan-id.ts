import { MigrationInterface, QueryRunner } from 'typeorm';

const MESSAGES_TABLE = 'video_message';
const TASKS_TABLE = 'video_tasks';

/**
 * 回填分段任务消息的 planId。
 *
 * 本次改动之前，分段任务的视频卡片消息 metadata 里只有 kind/taskId 等字段，
 * 没有 planId，前端无法区分它与普通生成卡，导致同一段结果在聊天流和分段面板重复出现。
 * 现在按 video_tasks.plan_id 把历史分段消息补上 planId，使旧会话与新增行为一致
 * （分段结果只在分段面板展示，聊天流隐藏）。
 *
 * 仅命中仍缺失 planId 的记录，可安全重复执行。
 */
export class BackfillSegmentMessagePlanId1791072000000 implements MigrationInterface {
  name = 'BackfillSegmentMessagePlanId1791072000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasTable(MESSAGES_TABLE)) ||
      !(await queryRunner.hasTable(TASKS_TABLE))
    ) {
      return;
    }

    await queryRunner.query(
      `UPDATE \`${MESSAGES_TABLE}\` m
        JOIN \`${TASKS_TABLE}\` t ON t.task_id = m.task_id
        SET m.metadata = JSON_SET(m.metadata, '$.planId', t.plan_id)
        WHERE t.plan_id IS NOT NULL
          AND m.metadata IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.kind')) IN ('video_generation_submitted', 'video_generation_result')
          AND JSON_EXTRACT(m.metadata, '$.planId') IS NULL`,
    );
  }

  async down(): Promise<void> {
    // 历史回填无法区分某条记录原本是否已带 planId，回滚会造成数据丢失，故不提供。
  }
}
