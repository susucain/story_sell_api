import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('deploy-backend.sh', () => {
  it('does not roll back to a schema-synchronizing image when migrations are enabled', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploy-backend-test-'));

    try {
      const deployDir = join(tempDir, 'deploy');
      const appEnv = join(tempDir, 'env.prod');
      const redisEnv = join(tempDir, 'redis.prod');
      const calls = join(tempDir, 'calls.log');
      const fakeBin = join(tempDir, 'bin');
      const scriptPath = join(tempDir, 'deploy-backend.sh');

      execFileSync('mkdir', ['-p', deployDir, fakeBin]);
      writeFileSync(join(deployDir, 'docker-compose.prod.yml'), 'services: {}\n');
      writeFileSync(
        appEnv,
        [
          'DB_NAME=hello',
          'DB_PASS=password',
          'DB_PORT=3306',
          'DB_USER=root',
          'RUN_MIGRATIONS=true',
        ].join('\n'),
      );
      writeFileSync(redisEnv, 'REDIS_PASSWORD=password\n');

      const source = readFileSync(
        join(process.cwd(), 'scripts/deploy-backend.sh'),
        'utf8',
      )
        .replace(
          'readonly APP_ENV="/etc/secrets/env.prod"',
          `readonly APP_ENV="${appEnv}"`,
        )
        .replace(
          'readonly REDIS_ENV="/etc/secrets/redis.prod"',
          `readonly REDIS_ENV="${redisEnv}"`,
        );
      writeFileSync(scriptPath, source, { mode: 0o700 });

      writeFileSync(
        join(fakeBin, 'docker'),
        [
          '#!/usr/bin/env bash',
          'printf "%s\\n" "$*" >> "$CALLS"',
          'if [[ "$1" == "inspect" ]]; then',
          '  printf "%s\\n" "registry.example/old-image:sha-old"',
          'fi',
        ].join('\n'),
        { mode: 0o700 },
      );
      writeFileSync(
        join(fakeBin, 'curl'),
        '#!/usr/bin/env bash\nexit 1\n',
        { mode: 0o700 },
      );
      writeFileSync(
        join(fakeBin, 'sleep'),
        '#!/usr/bin/env bash\nexit 0\n',
        { mode: 0o700 },
      );

      expect(() =>
        execFileSync(scriptPath, ['registry.example/new-image:sha-new'], {
          env: {
            ...process.env,
            CALLS: calls,
            DEPLOY_DIR: deployDir,
            PATH: `${fakeBin}:${process.env.PATH}`,
          },
          stdio: 'pipe',
        }),
      ).toThrow();

      const pullCalls = readFileSync(calls, 'utf8')
        .split('\n')
        .filter((call) => call.endsWith('pull nest-app'));
      expect(pullCalls).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
