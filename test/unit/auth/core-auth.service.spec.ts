import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as bcrypt from 'bcrypt';
import { AuthSession } from '../../../src/auth/entities/auth-session.entity';
import { AuthService } from '../../../src/auth/auth.service';
import { JwtAuthGuard } from '../../../src/auth/guards/jwt-auth.guard';
import { User } from '../../../src/users/entities/user.entity';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

jest.mock('@nestjs/jwt', () => ({
  JwtService: class JwtService {},
}));

const bcryptMock = jest.mocked(bcrypt);

const activeUser: User = {
  account: 'alice',
  avatarUrl: 'https://example.com/alice.jpg',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  douyinOpenid: 'douyin-openid',
  douyinUnionid: 'douyin-unionid',
  email: 'alice@example.com',
  id: 7,
  lastLoginAt: new Date('2026-09-01T00:00:00.000Z'),
  name: 'Alice',
  nickname: 'Alice',
  passwordHash: 'stored-password-hash',
  status: 'active',
  tokenVersion: 2,
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
};

function createServiceDependencies() {
  const usersService = {
    findAuthUserById: jest.fn().mockResolvedValue(activeUser),
    findByAccount: jest.fn().mockResolvedValue(activeUser),
    incrementTokenVersion: jest.fn().mockResolvedValue(undefined),
    recordLogin: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const sessionsRepository = {
    create: jest.fn((session: AuthSession) => session),
    findOne: jest.fn(),
    save: jest.fn((session: AuthSession) => Promise.resolve(session)),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const jwtService = {
    signAsync: jest.fn(),
    verifyAsync: jest.fn(),
  };
  const configService = {
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        BCRYPT_ROUNDS: '12',
        JWT_ACCESS_SECRET: 'access-secret',
        JWT_ACCESS_TTL: '15m',
        JWT_REFRESH_SECRET: 'refresh-secret',
        JWT_REFRESH_TTL: '30d',
      };
      return values[key];
    }),
  };

  return {
    configService,
    jwtService,
    service: new AuthService(
      usersService as never,
      sessionsRepository as never,
      jwtService as never,
      configService as never,
    ),
    sessionsRepository,
    usersService,
  };
}

function createSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    expiresAt: new Date('2026-10-01T00:00:00.000Z'),
    id: 'session-1',
    lastUsedAt: null,
    refreshTokenHash: 'stored-refresh-hash',
    revokedAt: null,
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    userId: activeUser.id,
    ...overrides,
  };
}

describe('AuthService', () => {
  beforeEach(() => {
    bcryptMock.compare.mockResolvedValue(true);
    bcryptMock.hash.mockResolvedValue('hashed-refresh-token');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('issues an access token and a hashed refresh session for valid active credentials', async () => {
    const { jwtService, service, sessionsRepository, usersService } =
      createServiceDependencies();
    jwtService.signAsync
      .mockResolvedValueOnce('access-token')
      .mockResolvedValueOnce('refresh-token');

    const result = await service.login({
      account: 'alice',
      password: 'correct-password',
    });

    expect(result).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      user: {
        account: 'alice',
        avatarUrl: 'https://example.com/alice.jpg',
        email: 'alice@example.com',
        id: 7,
        name: 'Alice',
        nickname: 'Alice',
        status: 'active',
      },
    });
    expect(bcryptMock.compare).toHaveBeenCalledWith(
      'correct-password',
      'stored-password-hash',
    );
    expect(usersService.recordLogin).toHaveBeenCalledWith(7, expect.any(Date));
    expect(sessionsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshTokenHash: 'hashed-refresh-token',
        userId: 7,
      }),
    );
  });

  it('rejects unknown credentials with the generic login error', async () => {
    const { service, usersService } = createServiceDependencies();
    usersService.findByAccount.mockResolvedValue(null);

    await expect(
      service.login({ account: 'missing', password: 'wrong-password' }),
    ).rejects.toEqual(new UnauthorizedException('账号或密码错误'));

    expect(bcryptMock.compare).not.toHaveBeenCalled();
  });

  it('rejects disabled credentials with the generic login error', async () => {
    const { service, usersService } = createServiceDependencies();
    usersService.findByAccount.mockResolvedValue({
      ...activeUser,
      status: 'disabled',
    });

    await expect(
      service.login({ account: 'alice', password: 'correct-password' }),
    ).rejects.toEqual(new UnauthorizedException('账号或密码错误'));
  });

  it('rotates a valid refresh session into a new hashed refresh session', async () => {
    const { jwtService, service, sessionsRepository } =
      createServiceDependencies();
    jwtService.verifyAsync.mockResolvedValue({
      jti: 'session-1',
      sub: activeUser.id,
      tokenVersion: activeUser.tokenVersion,
      type: 'refresh',
    });
    jwtService.signAsync
      .mockResolvedValueOnce('rotated-access-token')
      .mockResolvedValueOnce('rotated-refresh-token');
    sessionsRepository.findOne.mockResolvedValue(createSession());

    const result = await service.refresh('refresh-token');

    expect(result).toEqual({
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
      user: {
        account: 'alice',
        avatarUrl: 'https://example.com/alice.jpg',
        email: 'alice@example.com',
        id: 7,
        name: 'Alice',
        nickname: 'Alice',
        status: 'active',
      },
    });
    const [sessionId, rotationUpdate] = sessionsRepository.update.mock
      .calls[0] as [string, Partial<AuthSession>];
    expect(sessionId).toBe('session-1');
    expect(rotationUpdate.lastUsedAt).toBeInstanceOf(Date);
    expect(rotationUpdate.revokedAt).toBeInstanceOf(Date);
    expect(sessionsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshTokenHash: 'hashed-refresh-token',
        userId: 7,
      }),
    );
  });

  it('invalidates every session and increments the token version when a revoked refresh token is reused', async () => {
    const { jwtService, service, sessionsRepository, usersService } =
      createServiceDependencies();
    jwtService.verifyAsync.mockResolvedValue({
      jti: 'session-1',
      sub: activeUser.id,
      tokenVersion: activeUser.tokenVersion,
      type: 'refresh',
    });
    sessionsRepository.findOne.mockResolvedValue(
      createSession({ revokedAt: new Date('2026-09-12T00:00:00.000Z') }),
    );

    await expect(service.refresh('reused-refresh-token')).rejects.toEqual(
      new UnauthorizedException('登录已失效'),
    );

    const [criteria, revokedSessionUpdate] = sessionsRepository.update.mock
      .calls[0] as [
      { revokedAt: unknown; userId: number },
      Partial<AuthSession>,
    ];
    expect(criteria.userId).toBe(7);
    expect(criteria.revokedAt).toBeDefined();
    expect(revokedSessionUpdate.revokedAt).toBeInstanceOf(Date);
    expect(usersService.incrementTokenVersion).toHaveBeenCalledWith(7);
  });
});

function createGuardContext(authorization?: string) {
  const request = {
    headers: authorization ? { authorization } : {},
  };
  const context = {
    getClass: () => class ProtectedController {},
    getHandler: () => () => undefined,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  };

  return { context, request };
}

describe('JwtAuthGuard', () => {
  it('rejects a protected route without a bearer access token', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    };
    const jwtService = { verifyAsync: jest.fn() };
    const usersService = { findAuthUserById: jest.fn() };
    const configService = {
      get: jest.fn().mockReturnValue('access-secret'),
    };
    const guard = new JwtAuthGuard(
      reflector as unknown as Reflector,
      jwtService as never,
      usersService as never,
      configService as never,
    );
    const { context } = createGuardContext();

    await expect(guard.canActivate(context as never)).rejects.toEqual(
      new UnauthorizedException(),
    );
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('rejects an invalid bearer access token', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    };
    const jwtService = {
      verifyAsync: jest.fn().mockRejectedValue(new Error('invalid signature')),
    };
    const usersService = { findAuthUserById: jest.fn() };
    const configService = {
      get: jest.fn().mockReturnValue('access-secret'),
    };
    const guard = new JwtAuthGuard(
      reflector as unknown as Reflector,
      jwtService as never,
      usersService as never,
      configService as never,
    );
    const { context } = createGuardContext('Bearer invalid-token');

    await expect(guard.canActivate(context as never)).rejects.toEqual(
      new UnauthorizedException(),
    );
    expect(usersService.findAuthUserById).not.toHaveBeenCalled();
  });

  it('rejects a stale access token when the token version has changed', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    };
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        account: 'alice',
        sub: activeUser.id,
        tokenVersion: activeUser.tokenVersion - 1,
        type: 'access',
      }),
    };
    const usersService = {
      findAuthUserById: jest.fn().mockResolvedValue(activeUser),
    };
    const configService = {
      get: jest.fn().mockReturnValue('access-secret'),
    };
    const guard = new JwtAuthGuard(
      reflector as unknown as Reflector,
      jwtService as never,
      usersService as never,
      configService as never,
    );
    const { context } = createGuardContext('Bearer stale-token');

    await expect(guard.canActivate(context as never)).rejects.toEqual(
      new UnauthorizedException(),
    );
  });
});
