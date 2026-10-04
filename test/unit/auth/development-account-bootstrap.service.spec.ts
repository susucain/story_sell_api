import { ConfigService } from '@nestjs/config';
import { DevelopmentAccountBootstrapService } from '../../../src/auth/development-account-bootstrap.service';
import { User } from '../../../src/users/entities/user.entity';

describe('DevelopmentAccountBootstrapService', () => {
  const password = 'fixed-development-password';

  function createDependencies(options?: {
    account?: string;
    configuredPassword?: string;
    existingAccountOwner?: User | null;
    user?: User | null;
    passwordMatches?: boolean;
  }) {
    const user =
      options?.user === undefined
        ? ({
            id: 1,
            account: 'dev',
            passwordHash: 'stored-hash',
            name: 'Legacy user',
          } as User)
        : options.user;
    const accountOwner = options?.existingAccountOwner ?? null;
    const repository = {
      findOne: jest
        .fn()
        .mockImplementation(({ where }: { where: Partial<User> }) => {
          if (where.id === 1) return Promise.resolve(user);
          if (where.account) return Promise.resolve(accountOwner);
          return Promise.resolve(null);
        }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const manager = { getRepository: jest.fn().mockReturnValue(repository) };
    const dataSource = {
      transaction: jest
        .fn()
        .mockImplementation((callback: (value: typeof manager) => unknown) =>
          callback(manager),
        ),
    };
    const config = new ConfigService({
      DEV_ACCOUNT: options?.account,
      DEV_ACCOUNT_PASSWORD: options?.configuredPassword,
    });
    const bcryptCompare = jest
      .fn()
      .mockResolvedValue(options?.passwordMatches ?? false);
    const bcryptHash = jest.fn().mockResolvedValue('new-password-hash');
    const service = new DevelopmentAccountBootstrapService(
      dataSource as never,
      config,
      { compare: bcryptCompare, hash: bcryptHash },
    );

    return { bcryptCompare, bcryptHash, dataSource, repository, service };
  }

  it('does nothing when no development account configuration exists', async () => {
    const { dataSource, service } = createDependencies();

    await service.onApplicationBootstrap();

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects incomplete development account configuration', async () => {
    const { service } = createDependencies({ account: 'dev' });

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      'DEV_ACCOUNT and DEV_ACCOUNT_PASSWORD must be configured together',
    );
  });

  it('updates only credentials for the existing user 1', async () => {
    const { bcryptHash, repository, service } = createDependencies({
      account: 'Configured-Dev',
      configuredPassword: password,
    });

    await service.onApplicationBootstrap();

    expect(bcryptHash).toHaveBeenCalledWith(password, 12);
    expect(repository.update).toHaveBeenCalledWith(1, {
      account: 'Configured-Dev',
      passwordHash: 'new-password-hash',
    });
  });

  it('does not write when the configured credentials already match', async () => {
    const { repository, service } = createDependencies({
      account: 'dev',
      configuredPassword: password,
      passwordMatches: true,
    });

    await service.onApplicationBootstrap();

    expect(repository.update).not.toHaveBeenCalled();
  });

  it('rejects a configured account owned by another user', async () => {
    const { service } = createDependencies({
      account: 'shared-account',
      configuredPassword: password,
      existingAccountOwner: { id: 2, account: 'shared-account' } as User,
    });

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      'DEV_ACCOUNT is already assigned to another user',
    );
  });

  it('rejects when the existing user 1 cannot be found', async () => {
    const { service } = createDependencies({
      account: 'dev',
      configuredPassword: password,
      user: null,
    });

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      'Development account user with id 1 does not exist',
    );
  });
});
