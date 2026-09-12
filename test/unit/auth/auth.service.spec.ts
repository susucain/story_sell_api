import { User } from '../../../src/users/entities/user.entity';
import { UsersService } from '../../../src/users/users.service';

function getSeedDevelopmentAccount() {
  return require('../../../src/database/seed-development-account')
    .seedDevelopmentAccount as (options: any) => Promise<{
    created: boolean;
    id: number;
  }>;
}

describe('UsersService authentication lookups', () => {
  const userRepository = {
    delete: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('looks up a user by account with a repository where clause', async () => {
    const service = new UsersService(userRepository as never);

    await service.findByAccount('dev');

    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: { account: 'dev' },
    });
  });

  it('looks up an authentication user by id with a repository where clause', async () => {
    const service = new UsersService(userRepository as never);

    await service.findAuthUserById(42);

    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: { id: 42 },
    });
  });

  it('creates users through the repository', async () => {
    const service = new UsersService(userRepository as never);
    const createUserDto = { name: 'New user', email: 'new@example.com' };

    await service.create(createUserDto);

    expect(userRepository.save).toHaveBeenCalledWith(createUserDto);
  });

  it('finds all users through the repository', async () => {
    const service = new UsersService(userRepository as never);

    await service.findAll();

    expect(userRepository.find).toHaveBeenCalledWith();
  });

  it('finds one user by id through the repository', async () => {
    const service = new UsersService(userRepository as never);

    await service.findOne(7);

    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: { id: 7 },
    });
  });

  it('updates users through the repository', async () => {
    const service = new UsersService(userRepository as never);
    const updateUserDto = {
      name: 'Updated user',
      email: 'updated@example.com',
    };

    await service.update(7, updateUserDto);

    expect(userRepository.update).toHaveBeenCalledWith(7, updateUserDto);
  });

  it('removes users through the repository', async () => {
    const service = new UsersService(userRepository as never);

    await service.remove(7);

    expect(userRepository.delete).toHaveBeenCalledWith(7);
  });
});

describe('seedDevelopmentAccount', () => {
  const plaintextPassword = 'development-password';

  function createDependencies(existingUser?: User) {
    const userRepository = {
      findOneBy: jest.fn().mockResolvedValue(existingUser ?? null),
      insert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      destroy: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(userRepository),
      initialize: jest.fn().mockResolvedValue(undefined),
    };
    const dataSourceFactory = jest.fn().mockReturnValue(dataSource);
    const hashPassword = jest.fn().mockResolvedValue('bcrypt-password-hash');

    return {
      dataSource,
      dataSourceFactory,
      hashPassword,
      userRepository,
    };
  }

  it('rejects when development seeding is not explicitly enabled', async () => {
    const { dataSourceFactory, hashPassword } = createDependencies();

    await expect(
      getSeedDevelopmentAccount()({
        dataSourceFactory,
        env: { DEV_ACCOUNT_PASSWORD: plaintextPassword },
        hashPassword,
      }),
    ).rejects.toThrow('SEED_DEV_ACCOUNT must be set to "true"');

    expect(dataSourceFactory).not.toHaveBeenCalled();
  });

  it('rejects when the development account password is missing', async () => {
    const { dataSourceFactory, hashPassword } = createDependencies();

    await expect(
      getSeedDevelopmentAccount()({
        dataSourceFactory,
        env: { SEED_DEV_ACCOUNT: 'true' },
        hashPassword,
      }),
    ).rejects.toThrow('DEV_ACCOUNT_PASSWORD is required');

    expect(dataSourceFactory).not.toHaveBeenCalled();
  });

  it('creates the default development account at id 1 with a password hash', async () => {
    const { dataSource, dataSourceFactory, hashPassword, userRepository } =
      createDependencies();

    const result = await getSeedDevelopmentAccount()({
      dataSourceFactory,
      env: {
        DEV_ACCOUNT_PASSWORD: plaintextPassword,
        SEED_DEV_ACCOUNT: 'true',
      },
      hashPassword,
    });

    expect(hashPassword).toHaveBeenCalledWith(plaintextPassword, 12);
    expect(userRepository.insert).toHaveBeenCalledWith({
      account: 'dev',
      id: 1,
      passwordHash: 'bcrypt-password-hash',
    });
    expect(userRepository.insert.mock.calls[0][0].passwordHash).not.toBe(
      plaintextPassword,
    );
    expect(result).toEqual({ created: true, id: 1 });
    expect(dataSource.destroy).toHaveBeenCalledTimes(1);
  });

  it('allows an explicitly enabled seed in production', async () => {
    const { dataSource, dataSourceFactory, hashPassword, userRepository } =
      createDependencies();

    const result = await getSeedDevelopmentAccount()({
      dataSourceFactory,
      env: {
        DEV_ACCOUNT: 'production-dev',
        DEV_ACCOUNT_PASSWORD: plaintextPassword,
        NODE_ENV: 'production',
        SEED_DEV_ACCOUNT: 'true',
      },
      hashPassword,
    });

    expect(userRepository.insert).toHaveBeenCalledWith({
      account: 'production-dev',
      id: 1,
      passwordHash: 'bcrypt-password-hash',
    });
    expect(result).toEqual({ created: true, id: 1 });
    expect(dataSource.destroy).toHaveBeenCalledTimes(1);
  });

  it('backfills credentials on id 1 without replacing its profile', async () => {
    const existingUser = {
      id: 1,
      name: 'Existing profile',
      email: 'existing@example.com',
    } as User;
    const { dataSource, dataSourceFactory, hashPassword, userRepository } =
      createDependencies(existingUser);

    const result = await getSeedDevelopmentAccount()({
      dataSourceFactory,
      env: {
        DEV_ACCOUNT: 'configured-dev',
        DEV_ACCOUNT_PASSWORD: plaintextPassword,
        SEED_DEV_ACCOUNT: 'true',
      },
      hashPassword,
    });

    expect(userRepository.findOneBy).toHaveBeenCalledWith({ id: 1 });
    expect(userRepository.update).toHaveBeenCalledWith(1, {
      account: 'configured-dev',
      passwordHash: 'bcrypt-password-hash',
    });
    expect(userRepository.insert).not.toHaveBeenCalled();
    expect(result).toEqual({ created: false, id: 1 });
    expect(dataSource.destroy).toHaveBeenCalledTimes(1);
  });
});
