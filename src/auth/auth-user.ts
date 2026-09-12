import { User } from '../users/entities/user.entity';
import { AuthenticatedUser } from './auth.types';

export function toAuthenticatedUser(user: User): AuthenticatedUser {
  return {
    account: user.account ?? null,
    avatarUrl: user.avatarUrl ?? null,
    email: user.email ?? null,
    id: user.id,
    name: user.name ?? null,
    nickname: user.nickname ?? null,
    status: user.status,
  };
}
