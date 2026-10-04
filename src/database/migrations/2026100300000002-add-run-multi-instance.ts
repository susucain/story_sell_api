import {
  MigrationInterface,
  QueryRunner,
  TableColumn,
  TableIndex,
} from 'typeorm';

const RUNS_TABLE = 'agent_runs';
const RUNNING_KEY_UNIQUE = new TableIndex({
  name: 'IDX_agent_runs_running_key',
  columnNames: ['running_key'],
  isUnique: true,
});

/**
 * 多实例就绪：会话级互斥、跨实例取消、实例归属。
 *
 * `running_key` 在 run 处于 running 时等于 session_id，终态置空；配合唯一索引，
 * 多个实例并发为同一会话开链时只有一个能插入成功（MySQL 唯一索引允许多个 NULL，
 * 因此终态记录不冲突）。
 */
export class AddRunMultiInstance1790985600002 implements MigrationInterface {
  name = 'AddRunMultiInstance1790985600002';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable(RUNS_TABLE))) return;
    const table = await queryRunner.getTable(RUNS_TABLE);
    if (!table) return;

    const columns: TableColumn[] = [
      new TableColumn({
        name: 'instance_id',
        type: 'varchar',
        length: '64',
        isNullable: true,
        comment: '执行该 run 的实例标识（多实例排障用）',
      }),
      new TableColumn({
        name: 'running_key',
        type: 'varchar',
        length: '64',
        isNullable: true,
        comment:
          'running 期间等于 session_id，靠唯一约束保证跨实例「同会话至多一条链路」；终态置空',
      }),
      new TableColumn({
        name: 'cancel_requested_at',
        type: 'timestamp',
        isNullable: true,
        comment: '跨实例取消的持久标记（pub/sub 丢失时的兜底）',
      }),
    ];

    for (const column of columns) {
      if (!table.findColumnByName(column.name)) {
        await queryRunner.addColumn(RUNS_TABLE, column);
      }
    }

    const refreshed = await queryRunner.getTable(RUNS_TABLE);
    const existingIndex = refreshed?.indices.find(
      (index) =>
        index.name?.toLowerCase() === RUNNING_KEY_UNIQUE.name!.toLowerCase(),
    );
    if (!existingIndex) {
      await queryRunner.createIndex(RUNS_TABLE, RUNNING_KEY_UNIQUE);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable(RUNS_TABLE))) return;
    const table = await queryRunner.getTable(RUNS_TABLE);
    if (!table) return;

    if (table.indices.some((index) => index.name === RUNNING_KEY_UNIQUE.name)) {
      await queryRunner.dropIndex(RUNS_TABLE, RUNNING_KEY_UNIQUE);
    }
    for (const name of ['instance_id', 'running_key', 'cancel_requested_at']) {
      if (table.findColumnByName(name)) {
        await queryRunner.dropColumn(RUNS_TABLE, name);
      }
    }
  }
}
