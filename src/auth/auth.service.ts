import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import {
  ACCESS_TOKEN_DEFAULT_TTL,
  durationToMilliseconds,
  getBcryptRounds,
  getJwtTtl,
  getRequiredConfig,
  REFRESH_TOKEN_DEFAULT_TTL,
} from './auth.config';
import { toAuthenticatedUser } from './auth-user';
import {
  AccessTokenPayload,
  AuthTokenResponse,
  RefreshTokenPayload,
} from './auth.types';
import { LoginDto } from './dto/login.dto';
import { AuthSession } from './entities/auth-session.entity';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';

function isRefreshTokenPayload(value: unknown): value is RefreshTokenPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as Partial<RefreshTokenPayload>;
  return (
    typeof payload.jti === 'string' &&
    typeof payload.sub === 'number' &&
    typeof payload.tokenVersion === 'number' &&
    payload.type === 'refresh'
  );
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    @InjectRepository(AuthSession)
    private readonly sessionsRepository: Repository<AuthSession>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async login(loginDto: LoginDto): Promise<AuthTokenResponse> {
    const user = await this.usersService.findByAccount(loginDto.account);

    if (
      !user ||
      user.status !== 'active' ||
      !user.passwordHash ||
      !(await bcrypt.compare(loginDto.password, user.passwordHash))
    ) {
      throw new UnauthorizedException('账号或密码错误');
    }

    await this.usersService.recordLogin(user.id, new Date());
    return this.createTokenResponse(user);
  }

  async refresh(refreshToken: string | undefined): Promise<AuthTokenResponse> {
    if (!refreshToken) {
      throw new UnauthorizedException('登录已失效');
    }

    const payload = await this.verifyRefreshToken(refreshToken);
    const session = await this.sessionsRepository.findOne({
      where: { id: payload.jti, userId: payload.sub },
    });

    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      if (session?.revokedAt) {
        await this.revokeAllSessionsAndInvalidateTokens(payload.sub);
      }
      throw new UnauthorizedException('登录已失效');
    }

    const user = await this.usersService.findAuthUserById(payload.sub);
    if (
      !user ||
      user.status !== 'active' ||
      user.tokenVersion !== payload.tokenVersion
    ) {
      throw new UnauthorizedException('登录已失效');
    }

    const refreshTokenMatches = await bcrypt.compare(
      refreshToken,
      session.refreshTokenHash,
    );
    if (!refreshTokenMatches) {
      await this.revokeAllSessionsAndInvalidateTokens(user.id);
      throw new UnauthorizedException('登录已失效');
    }

    const now = new Date();
    await this.sessionsRepository.update(session.id, {
      lastUsedAt: now,
      revokedAt: now,
    });

    return this.createTokenResponse(user);
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    try {
      const payload = await this.verifyRefreshToken(refreshToken);
      await this.sessionsRepository.update(
        { id: payload.jti, userId: payload.sub, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );
    } catch {
      // Logout remains idempotent and always clears the browser cookie.
    }
  }

  private async createTokenResponse(user: User): Promise<AuthTokenResponse> {
    const expiresAt = new Date(
      Date.now() + durationToMilliseconds(this.getRefreshTokenTtl()),
    );
    const session = this.sessionsRepository.create({
      expiresAt,
      id: randomUUID(),
      refreshTokenHash: '',
      userId: user.id,
    });
    const accessToken = await this.signAccessToken(user);
    const refreshToken = await this.signRefreshToken(user, session.id);

    session.refreshTokenHash = await bcrypt.hash(
      refreshToken,
      getBcryptRounds(this.configService),
    );
    await this.sessionsRepository.save(session);

    return {
      accessToken,
      refreshToken,
      user: toAuthenticatedUser(user),
    };
  }

  private async signAccessToken(user: User): Promise<string> {
    const payload: AccessTokenPayload = {
      account: user.account ?? '',
      sub: user.id,
      tokenVersion: user.tokenVersion,
      type: 'access',
    };

    return this.jwtService.signAsync(payload, {
      expiresIn: this.getAccessTokenTtl() as JwtSignOptions['expiresIn'],
      secret: getRequiredConfig(this.configService, 'JWT_ACCESS_SECRET'),
    });
  }

  private async signRefreshToken(
    user: User,
    sessionId: string,
  ): Promise<string> {
    const payload: RefreshTokenPayload = {
      jti: sessionId,
      sub: user.id,
      tokenVersion: user.tokenVersion,
      type: 'refresh',
    };

    return this.jwtService.signAsync(payload, {
      expiresIn: this.getRefreshTokenTtl() as JwtSignOptions['expiresIn'],
      secret: getRequiredConfig(this.configService, 'JWT_REFRESH_SECRET'),
    });
  }

  private async verifyRefreshToken(
    refreshToken: string | undefined,
  ): Promise<RefreshTokenPayload> {
    if (!refreshToken) {
      throw new UnauthorizedException('登录已失效');
    }

    try {
      const payload = await this.jwtService.verifyAsync<
        Record<string, unknown>
      >(refreshToken, {
        secret: getRequiredConfig(this.configService, 'JWT_REFRESH_SECRET'),
      });
      if (!isRefreshTokenPayload(payload)) {
        throw new UnauthorizedException('登录已失效');
      }

      return payload;
    } catch {
      throw new UnauthorizedException('登录已失效');
    }
  }

  private async revokeAllSessionsAndInvalidateTokens(
    userId: number,
  ): Promise<void> {
    await this.sessionsRepository.update(
      { revokedAt: IsNull(), userId },
      { revokedAt: new Date() },
    );
    await this.usersService.incrementTokenVersion(userId);
  }

  private getAccessTokenTtl(): string | number {
    return getJwtTtl(
      this.configService,
      'JWT_ACCESS_TTL',
      ACCESS_TOKEN_DEFAULT_TTL,
    );
  }

  private getRefreshTokenTtl(): string | number {
    return getJwtTtl(
      this.configService,
      'JWT_REFRESH_TTL',
      REFRESH_TOKEN_DEFAULT_TTL,
    );
  }
}
