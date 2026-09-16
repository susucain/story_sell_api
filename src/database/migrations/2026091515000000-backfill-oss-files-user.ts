import { MigrationInterface, QueryRunner } from 'typeorm';

export class BackfillOssFilesUser1789484400000 implements MigrationInterface {
  name = 'BackfillOssFilesUser1789484400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'UPDATE `oss_files` SET `user_id` = 1 WHERE `user_id` IS NULL',
    );
  }

  async down(): Promise<void> {
    // Ownership cannot be safely inferred once legacy records are assigned.
  }
}
