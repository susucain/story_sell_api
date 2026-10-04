import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';

export type PasswordHasher = Pick<typeof bcrypt, 'compare' | 'hash'>;

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

@Injectable()
export class DevelopmentAccountBootstrapService implements OnApplicationBootstrap {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    @Inject(PASSWORD_HASHER)
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const account = this.configService.get<string>('DEV_ACCOUNT')?.trim();
    const password = this.configService.get<string>('DEV_ACCOUNT_PASSWORD');

    if (!account && !password) {
      return;
    }

    if (!account || !password) {
      throw new Error(
        'DEV_ACCOUNT and DEV_ACCOUNT_PASSWORD must be configured together',
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const usersRepository = manager.getRepository(User);
      const user = await usersRepository.findOne({
        where: { id: 1 },
        lock: { mode: 'pessimistic_write' },
      });

      if (!user) {
        throw new Error('Development account user with id 1 does not exist');
      }

      const existingAccountOwner = await usersRepository.findOne({
        where: { account },
      });
      if (existingAccountOwner && existingAccountOwner.id !== user.id) {
        throw new Error('DEV_ACCOUNT is already assigned to another user');
      }

      const passwordMatches = user.passwordHash
        ? await this.passwordHasher.compare(password, user.passwordHash)
        : false;
      if (user.account === account && passwordMatches) {
        return;
      }

      await usersRepository.update(user.id, {
        account,
        passwordHash: await this.passwordHasher.hash(password, 12),
      });
    });
  }
}
