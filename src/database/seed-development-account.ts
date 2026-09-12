import * as bcrypt from 'bcrypt';
import { config as loadEnvironment } from 'dotenv';
import { DataSource, DataSourceOptions, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';

type DevelopmentAccountRepository = Pick<
  Repository<User>,
  'findOneBy' | 'insert' | 'update'
>;

type DevelopmentAccountDataSource = {
  destroy(): Promise<void>;
  getRepository(target: typeof User): DevelopmentAccountRepository;
  initialize(): Promise<unknown>;
};

type HashPassword = (password: string, rounds: number) => Promise<string>;

export type SeedDevelopmentAccountOptions = {
  dataSourceFactory?: (env: NodeJS.ProcessEnv) => DevelopmentAccountDataSource;
  env?: NodeJS.ProcessEnv;
  hashPassword?: HashPassword;
};

function readDatabasePort(env: NodeJS.ProcessEnv): number {
  const port = Number(env.DB_PORT ?? 3306);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('DB_PORT must be a valid TCP port');
  }

  return port;
}

function requireDatabaseSetting(
  env: NodeJS.ProcessEnv,
  name: 'DB_HOST' | 'DB_USER' | 'DB_PASS' | 'DB_NAME',
): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required to seed the development account`);
  }

  return value;
}

export function createDevelopmentAccountDataSource(
  env: NodeJS.ProcessEnv = process.env,
): DataSource {
  const options: DataSourceOptions = {
    type: 'mysql',
    host: requireDatabaseSetting(env, 'DB_HOST'),
    port: readDatabasePort(env),
    username: requireDatabaseSetting(env, 'DB_USER'),
    password: requireDatabaseSetting(env, 'DB_PASS'),
    database: requireDatabaseSetting(env, 'DB_NAME'),
    entities: [User],
    synchronize: false,
  };

  return new DataSource(options);
}

export async function seedDevelopmentAccount(
  options: SeedDevelopmentAccountOptions = {},
): Promise<{ created: boolean; id: number }> {
  const env = options.env ?? process.env;
  if (env.SEED_DEV_ACCOUNT !== 'true') {
    throw new Error('SEED_DEV_ACCOUNT must be set to "true"');
  }

  const password = env.DEV_ACCOUNT_PASSWORD;
  if (!password) {
    throw new Error('DEV_ACCOUNT_PASSWORD is required');
  }

  const account = env.DEV_ACCOUNT?.trim() || 'dev';
  const hashPassword =
    options.hashPassword ??
    ((value: string, rounds: number) => bcrypt.hash(value, rounds));
  const passwordHash = await hashPassword(password, 12);
  const dataSource =
    options.dataSourceFactory?.(env) ?? createDevelopmentAccountDataSource(env);
  let initialized = false;

  try {
    await dataSource.initialize();
    initialized = true;

    const usersRepository = dataSource.getRepository(User);
    const existingUser = await usersRepository.findOneBy({ id: 1 });
    const credentials = { account, passwordHash };

    if (existingUser) {
      await usersRepository.update(1, credentials);
      return { created: false, id: 1 };
    }

    await usersRepository.insert({ id: 1, ...credentials });
    return { created: true, id: 1 };
  } finally {
    if (initialized) {
      await dataSource.destroy();
    }
  }
}

export async function main(): Promise<void> {
  loadEnvironment();
  await seedDevelopmentAccount();
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
