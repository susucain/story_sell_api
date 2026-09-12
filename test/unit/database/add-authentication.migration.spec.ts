import { Table, TableColumn, TableIndex } from 'typeorm';
import { AddAuthentication202609120001 } from '../../../src/database/migrations/202609120001-add-authentication';

type QueryRunnerCall = {
  method: string;
  args: unknown[];
};

class MigrationQueryRunner {
  readonly calls: QueryRunnerCall[] = [];

  private readonly tables = new Set(['users', 'oss_files']);
  private readonly columns = new Map<string, Set<string>>([
    ['users', new Set(['id'])],
    ['oss_files', new Set(['id'])],
  ]);

  async hasTable(tableName: string): Promise<boolean> {
    return this.tables.has(tableName);
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    return this.columns.get(tableName)?.has(columnName) ?? false;
  }

  async addColumn(tableName: string, column: TableColumn): Promise<void> {
    this.calls.push({ method: 'addColumn', args: [tableName, column] });
    this.columns.get(tableName)?.add(column.name);
  }

  async dropColumn(tableName: string, columnName: string): Promise<void> {
    this.calls.push({ method: 'dropColumn', args: [tableName, columnName] });
    this.columns.get(tableName)?.delete(columnName);
  }

  async createTable(table: Table): Promise<void> {
    this.calls.push({ method: 'createTable', args: [table] });
    this.tables.add(table.name);
    this.columns.set(
      table.name,
      new Set(table.columns.map((column) => column.name)),
    );
  }

  async dropTable(tableName: string): Promise<void> {
    this.calls.push({ method: 'dropTable', args: [tableName] });
    this.tables.delete(tableName);
    this.columns.delete(tableName);
  }

  async createIndex(tableName: string, index: TableIndex): Promise<void> {
    this.calls.push({ method: 'createIndex', args: [tableName, index] });
  }

  async dropIndex(tableName: string, indexName: string): Promise<void> {
    this.calls.push({ method: 'dropIndex', args: [tableName, indexName] });
  }
}

describe('AddAuthentication202609120001', () => {
  it('creates the authentication schema and indexes', async () => {
    const queryRunner = new MigrationQueryRunner();

    await new AddAuthentication202609120001().up(queryRunner as never);

    const addedColumns = queryRunner.calls
      .filter((call) => call.method === 'addColumn')
      .map((call) => call.args as [string, TableColumn]);

    expect(addedColumns).toEqual(
      expect.arrayContaining([
        [
          'users',
          expect.objectContaining({
            name: 'account',
            type: 'varchar',
            length: '64',
            isNullable: true,
          }),
        ],
        [
          'users',
          expect.objectContaining({
            name: 'password_hash',
            type: 'varchar',
            length: '255',
            isNullable: true,
          }),
        ],
        [
          'users',
          expect.objectContaining({
            name: 'token_version',
            type: 'int',
            default: '0',
            isNullable: false,
          }),
        ],
        [
          'oss_files',
          expect.objectContaining({
            name: 'user_id',
            type: 'int',
            isNullable: true,
          }),
        ],
      ]),
    );

    const authSessionsTable = queryRunner.calls.find(
      (call) => call.method === 'createTable',
    )?.args[0] as Table;
    expect(authSessionsTable.name).toBe('auth_sessions');
    expect(authSessionsTable.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          type: 'varchar',
          length: '36',
          isPrimary: true,
        }),
        expect.objectContaining({ name: 'user_id', type: 'int' }),
        expect.objectContaining({
          name: 'refresh_token_hash',
          type: 'varchar',
          length: '255',
        }),
        expect.objectContaining({ name: 'expires_at', type: 'datetime' }),
        expect.objectContaining({
          name: 'revoked_at',
          type: 'datetime',
          isNullable: true,
        }),
        expect.objectContaining({
          name: 'last_used_at',
          type: 'datetime',
          isNullable: true,
        }),
        expect.objectContaining({
          name: 'created_at',
          type: 'timestamp',
          default: 'CURRENT_TIMESTAMP',
        }),
        expect.objectContaining({
          name: 'updated_at',
          type: 'timestamp',
          default: 'CURRENT_TIMESTAMP',
          onUpdate: 'CURRENT_TIMESTAMP',
        }),
      ]),
    );

    const createdIndexes = queryRunner.calls
      .filter((call) => call.method === 'createIndex')
      .map((call) => call.args as [string, TableIndex]);

    expect(createdIndexes).toEqual(
      expect.arrayContaining([
        [
          'users',
          expect.objectContaining({
            name: 'IDX_users_account',
            columnNames: ['account'],
            isUnique: true,
          }),
        ],
        [
          'auth_sessions',
          expect.objectContaining({
            name: 'IDX_auth_sessions_user_id',
            columnNames: ['user_id'],
          }),
        ],
        [
          'oss_files',
          expect.objectContaining({
            name: 'IDX_oss_files_user_id',
            columnNames: ['user_id'],
          }),
        ],
      ]),
    );
  });

  it('reverses authentication schema changes in dependency-safe order', async () => {
    const queryRunner = new MigrationQueryRunner();
    const migration = new AddAuthentication202609120001();

    await migration.up(queryRunner as never);
    queryRunner.calls.splice(0);
    await migration.down(queryRunner as never);

    expect(
      queryRunner.calls.map((call) => [call.method, call.args[0]]),
    ).toEqual([
      ['dropIndex', 'oss_files'],
      ['dropColumn', 'oss_files'],
      ['dropTable', 'auth_sessions'],
      ['dropIndex', 'users'],
      ['dropColumn', 'users'],
      ['dropColumn', 'users'],
      ['dropColumn', 'users'],
    ]);
  });
});
