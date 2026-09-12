import type { Request } from 'express';

export type AccessTokenPayload = {
  account: string;
  sub: number;
  tokenVersion: number;
  type: 'access';
};

export type RefreshTokenPayload = {
  jti: string;
  sub: number;
  tokenVersion: number;
  type: 'refresh';
};

export type AuthenticatedUser = {
  account: string | null;
  avatarUrl: string | null;
  email: string | null;
  id: number;
  name: string | null;
  nickname: string | null;
  status: string;
};

export type AuthenticatedRequest = Request & {
  user: AuthenticatedUser;
};

export type AuthTokenResponse = {
  accessToken: string;
  refreshToken: string;
  user: AuthenticatedUser;
};
