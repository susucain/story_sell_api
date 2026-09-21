import { ConfigService } from '@nestjs/config';
import { getRefreshCookieOptions } from '../../../src/auth/auth.config';

describe('getRefreshCookieOptions', () => {
  it('uses AUTH_COOKIE_SECURE when enabled', () => {
    const options = getRefreshCookieOptions(
      new ConfigService({
        AUTH_COOKIE_SECURE: 'true',
        NODE_ENV: 'development',
      }),
    );

    expect(options.secure).toBe(true);
  });

  it('allows temporary HTTP deployments to disable Secure cookies', () => {
    const options = getRefreshCookieOptions(
      new ConfigService({
        AUTH_COOKIE_SECURE: 'false',
        NODE_ENV: 'production',
      }),
    );

    expect(options.secure).toBe(false);
  });
});
