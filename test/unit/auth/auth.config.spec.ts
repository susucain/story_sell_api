import { ConfigService } from '@nestjs/config';
import { getRefreshCookieOptions } from '../../../src/auth/auth.config';

describe('getRefreshCookieOptions', () => {
  it('uses AUTH_COOKIE_SECURE outside production', () => {
    const options = getRefreshCookieOptions(
      new ConfigService({
        AUTH_COOKIE_SECURE: 'true',
        NODE_ENV: 'development',
      }),
    );

    expect(options.secure).toBe(true);
  });
});
