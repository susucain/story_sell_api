import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableIndex,
} from 'typeorm';

const RUNS_TABLE = 'agent_runs';
const INVOCATIONS_TABLE = 'tool_invocations';
const INVOCATIONS_MARKER =
  'Added by resumable agent run migration 2026100300000001';

const RUN_TOOL_ARGS_UNIQUE = new TableIndex({
  name: 'IDX_tool_invocations_run_tool_args',
  columnNames: ['run_id', 'tool', 'args_hash'],
  isUnique: true,
});

const RUN_ID_INDEX = new TableIndex({
  name: 'IDX_tool_invocations_run_id',
  columnNames: ['run_id'],
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

export class AddRunSelfHealing1790985600001 implements MigrationInterface {
  name = 'AddRunSelfHealing1790985600001';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 1) agent_runs 增加心跳时间戳，用于识别崩溃遗留的孤儿 run
    if (await queryRunner.hasTable(RUNS_TABLE)) {
      const runsTable = await queryRunner.getTable(RUNS_TABLE);
      if (runsTable && !runsTable.findColumnByName('heartbeat_at')) {
        await queryRunner.addColumn(
          RUNS_TABLE,
          new TableColumn({
            name: 'heartbeat_at',
            type: 'timestamp',
            isNullable: true,
            comment: '最近一次心跳时间，用于识别崩溃遗留的孤儿 run',
          }),
        );
      }
    }

    // 2) 副作用工具调用台账
    if (!(await queryRunner.hasTable(INVOCATIONS_TABLE))) {
      await queryRunner.createTable(
        new Table({
          name: INVOCATIONS_TABLE,
          comment: INVOCATIONS_MARKER,
          columns: [
            {
              name: 'id',
              type: 'int',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            { name: 'run_id', type: 'varchar', length: '64' },
            { name: 'step_index', type: 'int', default: '0' },
            { name: 'tool', type: 'varchar', length: '64' },
            { name: 'args_hash', type: 'varchar', length: '64' },
            { name: 'status', type: 'varchar', length: '16' },
            {
              name: 'result_ref',
              type: 'varchar',
              length: '128',
              isNullable: true,
            },
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

    const invocationsTable = await queryRunner.getTable(INVOCATIONS_TABLE);
    if (!invocationsTable) return;

    if (!isOwnedIndex(invocationsTable, RUN_TOOL_ARGS_UNIQUE)) {
      await queryRunner.createIndex(INVOCATIONS_TABLE, RUN_TOOL_ARGS_UNIQUE);
    }
    if (!isOwnedIndex(invocationsTable, RUN_ID_INDEX)) {
      await queryRunner.createIndex(INVOCATIONS_TABLE, RUN_ID_INDEX);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const invocationsTable = await queryRunner.getTable(INVOCATIONS_TABLE);
    if (invocationsTable && invocationsTable.comment === INVOCATIONS_MARKER) {
      await queryRunner.dropTable(INVOCATIONS_TABLE);
    }

    if (await queryRunner.hasTable(RUNS_TABLE)) {
      const runsTable = await queryRunner.getTable(RUNS_TABLE);
      if (runsTable && runsTable.findColumnByName('heartbeat_at')) {
        await queryRunner.dropColumn(RUNS_TABLE, 'heartbeat_at');
      }
    }
  }
}
