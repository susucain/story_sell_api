import { ConfigService } from '@nestjs/config';
import type { CookieOptions } from 'express';

export const ACCESS_TOKEN_DEFAULT_TTL = '15m';
export const REFRESH_TOKEN_DEFAULT_TTL = '30d';
export const REFRESH_TOKEN_COOKIE = 'refreshToken';

type JwtDurationUnit = 'ms' | 's' | 'm' | 'h' | 'd';

const DURATION_IN_MILLISECONDS: Record<JwtDurationUnit, number> = {
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  ms: 1,
  s: 1000,
};

export function getRequiredConfig(
  configService: ConfigService,
  key: string,
): string {
  const value = configService.get<string>(key)?.trim();

  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}

export function getJwtTtl(
  configService: ConfigService,
  key: string,
  defaultValue: string,
): string | number {
  const value = configService.get<string>(key)?.trim() || defaultValue;

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  durationToMilliseconds(value);
  return value;
}

export function durationToMilliseconds(duration: string | number): number {
  if (typeof duration === 'number') {
    if (!Number.isInteger(duration) || duration <= 0) {
      throw new Error('JWT duration must be a positive integer');
    }

    return duration * 1000;
  }

  const match = /^(\d+)(ms|s|m|h|d)$/i.exec(duration);
  if (!match) {
    throw new Error(`Unsupported JWT duration "${duration}"`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase() as JwtDurationUnit;
  return amount * DURATION_IN_MILLISECONDS[unit];
}

export function getBcryptRounds(configService: ConfigService): number {
  const configuredRounds = configService.get<string>('BCRYPT_ROUNDS');
  if (!configuredRounds) {
    return 12;
  }

  const rounds = Number(configuredRounds);
  if (!Number.isInteger(rounds) || rounds < 10 || rounds > 14) {
    throw new Error('BCRYPT_ROUNDS must be an integer between 10 and 14');
  }

  return rounds;
}

export function getRefreshCookieOptions(
  configService: ConfigService,
): CookieOptions {
  const refreshTtl = getJwtTtl(
    configService,
    'JWT_REFRESH_TTL',
    REFRESH_TOKEN_DEFAULT_TTL,
  );

  return {
    httpOnly: true,
    maxAge: durationToMilliseconds(refreshTtl),
    path: '/auth',
    sameSite: 'lax',
    secure:
      configService.get<string>('COOKIE_SECURE') === 'true' ||
      configService.get<string>('NODE_ENV') === 'production',
  };
}

export function getRefreshCookieClearOptions(
  configService: ConfigService,
): CookieOptions {
  const options = getRefreshCookieOptions(configService);
  return {
    httpOnly: options.httpOnly,
    path: options.path,
    sameSite: options.sameSite,
    secure: options.secure,
  };
}
