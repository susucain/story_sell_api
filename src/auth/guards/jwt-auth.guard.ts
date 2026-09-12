import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { getRequiredConfig } from '../auth.config';
import { toAuthenticatedUser } from '../auth-user';
import { AccessTokenPayload, AuthenticatedRequest } from '../auth.types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { UsersService } from '../../users/users.service';

function getBearerToken(authorization: string | string[] | undefined): string {
  if (typeof authorization !== 'string') {
    throw new UnauthorizedException();
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) {
    throw new UnauthorizedException();
  }

  return match[1];
}

function isAccessTokenPayload(value: unknown): value is AccessTokenPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as Partial<AccessTokenPayload>;
  return (
    typeof payload.account === 'string' &&
    typeof payload.sub === 'number' &&
    typeof payload.tokenVersion === 'number' &&
    payload.type === 'access'
  );
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = getBearerToken(request.headers.authorization);
    const payload = await this.verifyAccessToken(token);
    const user = await this.usersService.findAuthUserById(payload.sub);

    if (
      !user ||
      user.status !== 'active' ||
      user.tokenVersion !== payload.tokenVersion
    ) {
      throw new UnauthorizedException();
    }

    request.user = toAuthenticatedUser(user);
    return true;
  }

  private async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<
        Record<string, unknown>
      >(token, {
        secret: getRequiredConfig(this.configService, 'JWT_ACCESS_SECRET'),
      });
      if (!isAccessTokenPayload(payload)) {
        throw new UnauthorizedException();
      }

      return payload;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
