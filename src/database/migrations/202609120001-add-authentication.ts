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
          }),
        );
      }

      await queryRunner.createIndex(USERS_TABLE, ACCOUNT_INDEX);
    }

    if (!(await queryRunner.hasTable(AUTH_SESSIONS_TABLE))) {
      await queryRunner.createTable(
        new Table({
          name: AUTH_SESSIONS_TABLE,
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
      await queryRunner.createIndex(
        AUTH_SESSIONS_TABLE,
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
          }),
        );
      }

      await queryRunner.createIndex(OSS_FILES_TABLE, OSS_FILES_USER_INDEX);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (
      (await queryRunner.hasTable(OSS_FILES_TABLE)) &&
      (await queryRunner.hasColumn(OSS_FILES_TABLE, 'user_id'))
    ) {
      await queryRunner.dropIndex(OSS_FILES_TABLE, OSS_FILES_USER_INDEX.name!);
      await queryRunner.dropColumn(OSS_FILES_TABLE, 'user_id');
    }

    if (await queryRunner.hasTable(AUTH_SESSIONS_TABLE)) {
      await queryRunner.dropTable(AUTH_SESSIONS_TABLE);
    }

    if (await queryRunner.hasTable(USERS_TABLE)) {
      if (await queryRunner.hasColumn(USERS_TABLE, 'account')) {
        await queryRunner.dropIndex(USERS_TABLE, ACCOUNT_INDEX.name!);
        await queryRunner.dropColumn(USERS_TABLE, 'account');
      }

      if (await queryRunner.hasColumn(USERS_TABLE, 'password_hash')) {
        await queryRunner.dropColumn(USERS_TABLE, 'password_hash');
      }

      if (await queryRunner.hasColumn(USERS_TABLE, 'token_version')) {
        await queryRunner.dropColumn(USERS_TABLE, 'token_version');
      }
    }
  }
}
