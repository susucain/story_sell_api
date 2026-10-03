import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableIndex,
} from 'typeorm';

const VIDEO_TASKS_TABLE = 'video_tasks';
const PLANS_TABLE = 'video_generation_plans';
const OWNERSHIP_MARKER =
  'Added by multi-segment video generation migration 2026100100000000';

const PLANS_SESSION_INDEX = new TableIndex({
  name: 'IDX_video_generation_plans_session_id',
  columnNames: ['session_id'],
});

const TASKS_PLAN_INDEX = new TableIndex({
  name: 'IDX_video_tasks_plan_id',
  columnNames: ['plan_id'],
});

function isOwnedIndex(table: Table, index: TableIndex): boolean {
  const owned = table.indices.find(
    (item) => item.name?.toLowerCase() === index.name!.toLowerCase(),
  );
  return (
    owned !== undefined &&
    owned.isUnique === index.isUnique &&
    owned.columnNames.length === index.columnNames.length &&
    owned.columnNames.every(
      (column, position) => column === index.columnNames[position],
    )
  );
}

export class AddVideoGenerationPlans1790780400000 implements MigrationInterface {
  name = 'AddVideoGenerationPlans1790780400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable(VIDEO_TASKS_TABLE)) {
      const newColumns: TableColumn[] = [
        new TableColumn({
          name: 'plan_id',
          type: 'int',
          isNullable: true,
          comment: OWNERSHIP_MARKER,
        }),
        new TableColumn({
          name: 'segment_index',
          type: 'int',
          isNullable: true,
          comment: OWNERSHIP_MARKER,
        }),
        new TableColumn({
          name: 'prev_task_id',
          type: 'varchar',
          length: '128',
          isNullable: true,
          comment: OWNERSHIP_MARKER,
        }),
        new TableColumn({
          name: 'continuity_mode',
          type: 'varchar',
          length: '16',
          isNullable: true,
          comment: OWNERSHIP_MARKER,
        }),
      ];

      for (const column of newColumns) {
        if (!(await queryRunner.hasColumn(VIDEO_TASKS_TABLE, column.name))) {
          await queryRunner.addColumn(VIDEO_TASKS_TABLE, column);
        }
      }

      const videoTasksTable = await queryRunner.getTable(VIDEO_TASKS_TABLE);
      if (videoTasksTable && !isOwnedIndex(videoTasksTable, TASKS_PLAN_INDEX)) {
        await queryRunner.createIndex(VIDEO_TASKS_TABLE, TASKS_PLAN_INDEX);
      }
    }

    if (!(await queryRunner.hasTable(PLANS_TABLE))) {
      await queryRunner.createTable(
        new Table({
          name: PLANS_TABLE,
          comment: OWNERSHIP_MARKER,
          columns: [
            {
              name: 'id',
              type: 'int',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            { name: 'session_id', type: 'varchar', length: '64' },
            { name: 'user_id', type: 'int' },
            { name: 'script_id', type: 'int' },
            { name: 'target_duration', type: 'int' },
            { name: 'segment_duration', type: 'int', default: '15' },
            { name: 'total_segments', type: 'int' },
            { name: 'completed_segments', type: 'int', default: '0' },
            {
              name: 'status',
              type: 'varchar',
              length: '32',
              default: "'planning'",
            },
            { name: 'assembled_video_url', type: 'text', isNullable: true },
            {
              name: 'created_at',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
            },
            {
              name: 'updated_at',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
              onUpdate: 'CURRENT_TIMESTAMP',
            },
          ],
        }),
      );
    }

    const plansTable = await queryRunner.getTable(PLANS_TABLE);
    if (plansTable && !isOwnedIndex(plansTable, PLANS_SESSION_INDEX)) {
      await queryRunner.createIndex(PLANS_TABLE, PLANS_SESSION_INDEX);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const plansTable = await queryRunner.getTable(PLANS_TABLE);
    if (plansTable && plansTable.comment === OWNERSHIP_MARKER) {
      await queryRunner.dropTable(PLANS_TABLE);
    }

    const videoTasksTable = await queryRunner.getTable(VIDEO_TASKS_TABLE);
    if (!videoTasksTable) return;

    if (isOwnedIndex(videoTasksTable, TASKS_PLAN_INDEX)) {
      await queryRunner.dropIndex(VIDEO_TASKS_TABLE, TASKS_PLAN_INDEX.name!);
    }

    for (const columnName of [
      'plan_id',
      'segment_index',
      'prev_task_id',
      'continuity_mode',
    ]) {
      const column = videoTasksTable.findColumnByName(columnName);
      if (column?.comment === OWNERSHIP_MARKER) {
        await queryRunner.dropColumn(VIDEO_TASKS_TABLE, columnName);
      }
    }
  }
}
