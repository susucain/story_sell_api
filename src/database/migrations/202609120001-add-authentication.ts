import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableIndex,
} from 'typeorm';

const USERS_TABLE = 'users';
const OSS_FILES_TABLE = 'oss_files';
const AUTH_SESSIONS_TABLE = 'auth_sessions';
const OWNERSHIP_MARKER = 'Added by authentication migration 202609120001';

const ACCOUNT_INDEX = new TableIndex({
  name: 'IDX_users_account',
  columnNames: ['account'],
  isUnique: true,
});

const AUTH_SESSIONS_USER_INDEX = new TableIndex({
  name: 'IDX_auth_sessions_user_id',
  columnNames: ['user_id'],
});

const OSS_FILES_USER_INDEX = new TableIndex({
  name: 'IDX_oss_files_user_id',
  columnNames: ['user_id'],
});

type ExpectedColumn = {
  name: string;
  type: string;
  length?: string;
  isNullable: boolean;
  isPrimary?: boolean;
  default?: string;
  onUpdate?: string;
};

function matchesExpectedIndex(
  index: TableIndex,
  expectedIndex: TableIndex,
): boolean {
  return (
    index.name === expectedIndex.name &&
    index.isUnique === expectedIndex.isUnique &&
    index.columnNames.length === expectedIndex.columnNames.length &&
    index.columnNames.every(
      (columnName, indexPosition) =>
        columnName === expectedIndex.columnNames[indexPosition],
    )
  );
}

function hasExpectedIndex(table: Table, expectedIndex: TableIndex): boolean {
  return table.indices.some((index) =>
    matchesExpectedIndex(index, expectedIndex),
  );
}

async function ensureExpectedIndex(
  queryRunner: QueryRunner,
  table: Table,
  expectedIndex: TableIndex,
): Promise<void> {
  if (hasExpectedIndex(table, expectedIndex)) {
    return;
  }

  const conflictingIndex = table.indices.find(
    (index) => index.name === expectedIndex.name,
  );
  if (conflictingIndex) {
    throw new Error(
      `Cannot create required index "${expectedIndex.name}" on table "${table.name}" because an index with that name has a different definition. Rename or drop the conflicting index, then rerun this migration.`,
    );
  }

  await queryRunner.createIndex(table.name, expectedIndex);
}

function hasUnexpectedIndexForColumn(
  table: Table,
  columnName: string,
  expectedIndex?: TableIndex,
): boolean {
  return table.indices.some(
    (index) =>
      index.columnNames.includes(columnName) &&
      (!expectedIndex ||
        index.name !== expectedIndex.name ||
        index.isUnique !== expectedIndex.isUnique ||
        index.columnNames.length !== expectedIndex.columnNames.length ||
        index.columnNames.some(
          (indexedColumn, indexPosition) =>
            indexedColumn !== expectedIndex.columnNames[indexPosition],
        )),
  );
}

function normalizeExpression(expression: unknown): string | undefined {
  if (expression === undefined) {
    return undefined;
  }

  return String(expression)
    .replace(/[`()'"]/g, '')
    .toUpperCase();
}

function matchesExpectedColumn(
  column: TableColumn,
  expectedColumn: ExpectedColumn,
): boolean {
  return (
    column.type === expectedColumn.type &&
    column.length === (expectedColumn.length ?? '') &&
    column.isNullable === expectedColumn.isNullable &&
    column.isPrimary === (expectedColumn.isPrimary ?? false) &&
    normalizeExpression(column.default) ===
      normalizeExpression(expectedColumn.default) &&
    normalizeExpression(column.onUpdate) ===
      normalizeExpression(expectedColumn.onUpdate)
  );
}

function isOwnedColumn(table: Table, expectedColumn: ExpectedColumn): boolean {
  const column = table.findColumnByName(expectedColumn.name);

  return (
    column !== undefined &&
    column.comment === OWNERSHIP_MARKER &&
    matchesExpectedColumn(column, expectedColumn)
  );
}

function isOwnedAuthSessionsTable(table: Table): boolean {
  const expectedColumns: ExpectedColumn[] = [
    {
      name: 'id',
      type: 'varchar',
      length: '36',
      isNullable: false,
      isPrimary: true,
    },
    { name: 'user_id', type: 'int', isNullable: false },
    {
      name: 'refresh_token_hash',
      type: 'varchar',
      length: '255',
      isNullable: false,
    },
    { name: 'expires_at', type: 'datetime', isNullable: false },
    { name: 'revoked_at', type: 'datetime', isNullable: true },
    { name: 'last_used_at', type: 'datetime', isNullable: true },
    {
      name: 'created_at',
      type: 'timestamp',
      isNullable: false,
      default: 'CURRENT_TIMESTAMP',
    },
    {
      name: 'updated_at',
      type: 'timestamp',
      isNullable: false,
      default: 'CURRENT_TIMESTAMP',
      onUpdate: 'CURRENT_TIMESTAMP',
    },
  ];

  return (
    table.comment === OWNERSHIP_MARKER &&
    table.columns.length === expectedColumns.length &&
    expectedColumns.every((column) => {
      const existingColumn = table.findColumnByName(column.name);
      return (
        existingColumn !== undefined &&
        matchesExpectedColumn(existingColumn, column)
      );
    }) &&
    table.indices.length === 1 &&
    hasExpectedIndex(table, AUTH_SESSIONS_USER_INDEX) &&
    table.foreignKeys.length === 0 &&
    table.uniques.length === 0 &&
    table.checks.length === 0 &&
    table.exclusions.length === 0
  );
}

/**
 * TypeORM does not persist ownership for individually-created schema objects.
 * The migration marks only objects it creates, so unmarked legacy schema is
 * never deleted. Indexes added to unmarked legacy resources are retained on
 * down(), and any altered marker or expected schema is left in place.
 */
export class AddAuthentication202609120001 implements MigrationInterface {
  name = 'AddAuthentication202609120001';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable(USERS_TABLE)) {
      if (!(await queryRunner.hasColumn(USERS_TABLE, 'account'))) {
        await queryRunner.addColumn(
          USERS_TABLE,
          new TableColumn({
            name: 'account',
            type: 'varchar',
            length: '64',
            isNullable: true,
            comment: OWNERSHIP_MARKER,
          }),
        );
      }

      if (!(await queryRunner.hasColumn(USERS_TABLE, 'password_hash'))) {
        await queryRunner.addColumn(
          USERS_TABLE,
          new TableColumn({
            name: 'password_hash',
            type: 'varchar',
            length: '255',
            isNullable: true,
            comment: OWNERSHIP_MARKER,
          }),
        );
      }

      if (!(await queryRunner.hasColumn(USERS_TABLE, 'token_version'))) {
        await queryRunner.addColumn(
          USERS_TABLE,
          new TableColumn({
            name: 'token_version',
            type: 'int',
            isNullable: false,
            default: '0',
            comment: OWNERSHIP_MARKER,
          }),
        );
      }

      const usersTable = await queryRunner.getTable(USERS_TABLE);
      if (usersTable) {
        await ensureExpectedIndex(queryRunner, usersTable, ACCOUNT_INDEX);
      }
    }

    let authSessionsTable = await queryRunner.getTable(AUTH_SESSIONS_TABLE);
    if (!authSessionsTable) {
      await queryRunner.createTable(
        new Table({
          name: AUTH_SESSIONS_TABLE,
          comment: OWNERSHIP_MARKER,
          columns: [
            {
              name: 'id',
              type: 'varchar',
              length: '36',
              isPrimary: true,
            },
            {
              name: 'user_id',
              type: 'int',
            },
            {
              name: 'refresh_token_hash',
              type: 'varchar',
              length: '255',
            },
            {
              name: 'expires_at',
              type: 'datetime',
            },
            {
              name: 'revoked_at',
              type: 'datetime',
              isNullable: true,
            },
            {
              name: 'last_used_at',
              type: 'datetime',
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
      authSessionsTable = await queryRunner.getTable(AUTH_SESSIONS_TABLE);
    }

    if (authSessionsTable) {
      await ensureExpectedIndex(
        queryRunner,
        authSessionsTable,
        AUTH_SESSIONS_USER_INDEX,
      );
    }

    if (await queryRunner.hasTable(OSS_FILES_TABLE)) {
      if (!(await queryRunner.hasColumn(OSS_FILES_TABLE, 'user_id'))) {
        await queryRunner.addColumn(
          OSS_FILES_TABLE,
          new TableColumn({
            name: 'user_id',
            type: 'int',
            isNullable: true,
            comment: OWNERSHIP_MARKER,
          }),
        );
      }

      const ossFilesTable = await queryRunner.getTable(OSS_FILES_TABLE);
      if (ossFilesTable) {
        await ensureExpectedIndex(
          queryRunner,
          ossFilesTable,
          OSS_FILES_USER_INDEX,
        );
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const ossFilesTable = await queryRunner.getTable(OSS_FILES_TABLE);
    if (
      ossFilesTable &&
      isOwnedColumn(ossFilesTable, {
        name: 'user_id',
        type: 'int',
        isNullable: true,
      }) &&
      !hasUnexpectedIndexForColumn(
        ossFilesTable,
        'user_id',
        OSS_FILES_USER_INDEX,
      )
    ) {
      if (hasExpectedIndex(ossFilesTable, OSS_FILES_USER_INDEX)) {
        await queryRunner.dropIndex(
          OSS_FILES_TABLE,
          OSS_FILES_USER_INDEX.name!,
        );
      }
      await queryRunner.dropColumn(OSS_FILES_TABLE, 'user_id');
    }

    const authSessionsTable = await queryRunner.getTable(AUTH_SESSIONS_TABLE);
    if (authSessionsTable && isOwnedAuthSessionsTable(authSessionsTable)) {
      await queryRunner.dropTable(AUTH_SESSIONS_TABLE);
    }

    const usersTable = await queryRunner.getTable(USERS_TABLE);
    if (usersTable) {
      if (
        isOwnedColumn(usersTable, {
          name: 'account',
          type: 'varchar',
          length: '64',
          isNullable: true,
        }) &&
        !hasUnexpectedIndexForColumn(usersTable, 'account', ACCOUNT_INDEX)
      ) {
        if (hasExpectedIndex(usersTable, ACCOUNT_INDEX)) {
          await queryRunner.dropIndex(USERS_TABLE, ACCOUNT_INDEX.name!);
        }
        await queryRunner.dropColumn(USERS_TABLE, 'account');
      }

      if (
        isOwnedColumn(usersTable, {
          name: 'password_hash',
          type: 'varchar',
          length: '255',
          isNullable: true,
        }) &&
        !hasUnexpectedIndexForColumn(usersTable, 'password_hash')
      ) {
        await queryRunner.dropColumn(USERS_TABLE, 'password_hash');
      }

      if (
        isOwnedColumn(usersTable, {
          name: 'token_version',
          type: 'int',
          isNullable: false,
          default: '0',
        }) &&
        !hasUnexpectedIndexForColumn(usersTable, 'token_version')
      ) {
        await queryRunner.dropColumn(USERS_TABLE, 'token_version');
      }
    }
  }
}
