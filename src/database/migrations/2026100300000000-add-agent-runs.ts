import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

const RUNS_TABLE = 'agent_runs';
const OWNERSHIP_MARKER =
  'Added by resumable agent run migration 2026100300000000';

const RUN_ID_INDEX = new TableIndex({
  name: 'IDX_agent_runs_run_id',
  columnNames: ['run_id'],
  isUnique: true,
});

const SESSION_INDEX = new TableIndex({
  name: 'IDX_agent_runs_session_id',
  columnNames: ['session_id'],
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

export class AddAgentRuns1790985600000 implements MigrationInterface {
  name = 'AddAgentRuns1790985600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable(RUNS_TABLE))) {
      await queryRunner.createTable(
        new Table({
          name: RUNS_TABLE,
          comment: OWNERSHIP_MARKER,
          columns: [
            {
              name: 'id',
              type: 'int',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            { name: 'run_id', type: 'varchar', length: '64' },
            { name: 'session_id', type: 'varchar', length: '64' },
            { name: 'user_id', type: 'int' },
            {
              name: 'status',
              type: 'varchar',
              length: '32',
              default: "'running'",
            },
            {
              name: 'error_code',
              type: 'varchar',
              length: '64',
              isNullable: true,
            },
            { name: 'started_at', type: 'timestamp' },
            { name: 'finished_at', type: 'timestamp', isNullable: true },
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

    const runsTable = await queryRunner.getTable(RUNS_TABLE);
    if (!runsTable) return;

    if (!isOwnedIndex(runsTable, RUN_ID_INDEX)) {
      await queryRunner.createIndex(RUNS_TABLE, RUN_ID_INDEX);
    }
    if (!isOwnedIndex(runsTable, SESSION_INDEX)) {
      await queryRunner.createIndex(RUNS_TABLE, SESSION_INDEX);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const runsTable = await queryRunner.getTable(RUNS_TABLE);
    if (runsTable && runsTable.comment === OWNERSHIP_MARKER) {
      await queryRunner.dropTable(RUNS_TABLE);
    }
  }
}
