# Login JWT Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account/password login with rotating JWT refresh sessions, enforce per-user ownership across the video workspace, and ship the approved workspace-preview login UI.

**Architecture:** NestJS gets an `AuthModule` backed by `@nestjs/jwt`, bcrypt password hashes, and a persisted refresh-session table. A global JWT guard supplies the authenticated user ID to video and OSS handlers, replacing all client-supplied `user_id` values and the fallback user `1`. React owns a memory-only access token and refreshes through an HttpOnly cookie.

**Tech Stack:** NestJS 11, TypeORM/MySQL, `@nestjs/jwt`, bcrypt, `@nestjs/throttler`, cookie-parser, React 19, React Router 7, Vite, Ant Design.

---

## File Structure

### Backend (`nest-langchain`)

- Create: `src/auth/auth.module.ts` - wires JWT, throttling, controller, services, guard.
- Create: `src/auth/auth.controller.ts` - login, refresh, logout, and current-user endpoints.
- Create: `src/auth/auth.service.ts` - password validation, token issuance, rotation, and revocation.
- Create: `src/auth/auth.guard.ts` - access-token verification and active-user/token-version validation.
- Create: `src/auth/auth-user.decorator.ts` - typed `@CurrentUser()` decorator.
- Create: `src/auth/dto/login.dto.ts` - validated login request.
- Create: `src/auth/entities/auth-session.entity.ts` - persisted refresh session.
- Create: `src/auth/types/auth-user.type.ts` - JWT payload and request principal types.
- Create: `src/database/migrations/202609120001-add-authentication.ts` - user credential, session, and OSS ownership schema migration.
- Create: `src/database/seed-development-account.ts` - explicit development user `id=1` seed command.
- Create: `test/unit/auth/auth.service.spec.ts` - credential, refresh rotation, revocation unit tests.
- Create: `test/unit/auth/auth.guard.spec.ts` - bearer-token guard unit tests.
- Create: `test/unit/oss/oss.service.spec.ts` - owner-scoped OSS query tests.
- Modify: `package.json` - add authentication/runtime dependencies and `seed:dev-account`.
- Modify: `src/app.module.ts` - register `AuthModule`, `AuthSession`, migrations, and production-safe TypeORM configuration.
- Modify: `src/main.ts` - cookie parser, global validation, named CORS origin, protected TTS WebSocket handshake.
- Modify: `src/users/entities/user.entity.ts` - credential and token-version fields.
- Modify: `src/users/users.module.ts` and `src/users/users.service.ts` - repository access and safe account lookup methods.
- Modify: `src/users/users.controller.ts` - remove public CRUD surface from application routing.
- Modify: `src/video/video.controller.ts` - derive owner from `@CurrentUser()` for all protected methods.
- Modify: `src/video/video.service.ts` - require and scope `userId` for every session/resource operation.
- Modify: `src/video/video-task.service.ts` - scope task actions and subscriptions to user ownership.
- Modify: `src/oss/entities/oss.entity.ts`, `src/oss/oss.controller.ts`, `src/oss/oss.service.ts` - user-owned OSS records.
- Modify: `src/video/video.module.ts`, `src/oss/oss.module.ts` - import authentication dependencies as needed.
- Modify: `env.prod.example` - JWT, CORS, and development-account variables.

### Frontend (`agui-frontend`)

- Create: `src/auth/auth-api.ts` - login/refresh/logout/me transport and typed payloads.
- Create: `src/auth/AuthProvider.tsx` - memory access token, bootstrap refresh, single-flight refresh.
- Create: `src/auth/RequireAuth.tsx` - protected route redirect.
- Create: `src/pages/Login/index.tsx` - approved workspace-preview login screen.
- Create: `src/pages/Login/style.css` - responsive login-specific styling.
- Create: `src/lib/api-fetch.ts` - authenticated fetch and one-time 401 retry.
- Modify: `src/main.tsx` - mount `AuthProvider`.
- Modify: `src/App.tsx` - add `/login`, protect `/life-video`, preserve redirect target.
- Modify: `vite.config.ts` - proxy `/auth`.
- Modify: `src/pages/VideoStoryboard/api.ts` - remove `user_id`, use `apiFetch`, use authenticated fetch-stream SSE.
- Modify: `src/pages/VideoStoryboard/index.tsx` - remove `FALLBACK_USER_ID` and client `user_id` plumbing.
- Create: `src/auth/auth-api.test.ts` and `src/pages/Login/index.test.tsx` if the project’s test runner is introduced; otherwise test the route/API behavior in the backend e2e suite and browser smoke test during this change.

## Task 1: Establish Dependencies and Migration Runtime

**Files:**
- Modify: `nest-langchain/package.json`
- Modify: `nest-langchain/src/app.module.ts`
- Create: `nest-langchain/src/database/migrations/202609120001-add-authentication.ts`
- Modify: `nest-langchain/env.prod.example`

- [ ] **Step 1: Add backend dependencies**

  Run:

  ```bash
  cd /Users/susucain/开发/agui-project/nest-langchain
  pnpm add @nestjs/jwt @nestjs/throttler bcrypt cookie-parser
  pnpm add -D @types/bcrypt @types/cookie-parser
  ```

- [ ] **Step 2: Write the migration before changing entities**

  Create a migration that:

  ```ts
  await queryRunner.addColumns('users', [
    new TableColumn({ name: 'account', type: 'varchar', length: '64', isNullable: true }),
    new TableColumn({ name: 'password_hash', type: 'varchar', length: '255', isNullable: true }),
    new TableColumn({ name: 'token_version', type: 'int', default: '0', isNullable: false }),
  ]);
  await queryRunner.createTable(new Table({
    name: 'auth_sessions',
    columns: [
      { name: 'id', type: 'varchar', length: '36', isPrimary: true },
      { name: 'user_id', type: 'int', isNullable: false },
      { name: 'refresh_token_hash', type: 'varchar', length: '255', isNullable: false },
      { name: 'expires_at', type: 'datetime', isNullable: false },
      { name: 'revoked_at', type: 'datetime', isNullable: true },
      { name: 'last_used_at', type: 'datetime', isNullable: true },
      { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
      { name: 'updated_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' },
    ],
  }));
  ```

  Add a unique index on `users.account`, an index on `auth_sessions.user_id`, then
  add nullable `oss_files.user_id` and index it. Leave credentials nullable inside
  this migration so it is safe on existing installations; the seed/provision task
  supplies credentials before any account can log in.

- [ ] **Step 3: Configure migrations and safe production sync behavior**

  In `AppModule`, include `AuthSession` in `entities`, point `migrations` at
  `database/migrations/*{.js,.ts}`, and set:

  ```ts
  synchronize: false,
  migrationsRun: configService.get<string>('RUN_MIGRATIONS') === 'true',
  ```

  Add `RUN_MIGRATIONS`, both JWT secrets/TTLs, `CORS_ORIGIN`, and development-account
  variables to `env.prod.example`.

- [ ] **Step 4: Validate compilation**

  Run: `pnpm build`

  Expected: build passes after entity imports are temporarily added in Task 2; before
  then, only the migration file is present and no schema behavior changes.

- [ ] **Step 5: Commit**

  ```bash
  git add package.json pnpm-lock.yaml src/app.module.ts src/database/migrations/202609120001-add-authentication.ts env.prod.example
  git commit -m "chore: add authentication runtime dependencies"
  ```

## Task 2: Model Credentials, Refresh Sessions, and Development User 1

**Files:**
- Modify: `nest-langchain/src/users/entities/user.entity.ts`
- Modify: `nest-langchain/src/users/users.module.ts`
- Modify: `nest-langchain/src/users/users.service.ts`
- Create: `nest-langchain/src/auth/entities/auth-session.entity.ts`
- Create: `nest-langchain/src/database/seed-development-account.ts`
- Modify: `nest-langchain/package.json`
- Test: `nest-langchain/test/unit/auth/auth.service.spec.ts`

- [ ] **Step 1: Write failing user/session persistence tests**

  Add tests that assert a credential lookup uses `account`, development account
  creation keeps `id: 1`, and no plaintext password is passed to repository save:

  ```ts
  expect(repo.findOne).toHaveBeenCalledWith({ where: { account: 'dev' } });
  expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({
    id: 1,
    account: 'dev',
    passwordHash: expect.not.stringMatching('dev-password'),
  }));
  ```

- [ ] **Step 2: Run the new test**

  Run: `pnpm test -- auth.service.spec.ts`

  Expected: FAIL because `findByAccount` and the auth session entity do not exist.

- [ ] **Step 3: Add typed entity fields and repository methods**

  Add to `User`:

  ```ts
  @Column({ length: 64, unique: true, nullable: true })
  account: string | null;

  @Column({ name: 'password_hash', length: 255, nullable: true })
  passwordHash: string | null;

  @Column({ name: 'token_version', default: 0 })
  tokenVersion: number;
  ```

  Implement `UsersService.findByAccount(account: string)` and
  `UsersService.findAuthUserById(id: number)`. Register TypeORM repositories in
  `UsersModule` instead of injecting a broad `EntityManager` for these read paths.

  Model `AuthSession` with UUID string `id`, `userId`, `refreshTokenHash`,
  `expiresAt`, `revokedAt`, `lastUsedAt`, `createdAt`, and `updatedAt`.

- [ ] **Step 4: Implement explicit development account seeding**

  The executable:

  ```ts
  if (process.env.NODE_ENV !== 'development' || process.env.SEED_DEV_ACCOUNT !== 'true') {
    throw new Error('开发账号只能在 development 环境通过 SEED_DEV_ACCOUNT=true 创建');
  }
  ```

  requires `DEV_ACCOUNT_PASSWORD`, hashes it using `bcrypt.hash(password, 12)`,
  and uses `repository.save({ id: 1, account, passwordHash, status: 'active' })`.
  It must never mutate the `id` of an existing user `1`.

  Add `"seed:dev-account": "tsx src/database/seed-development-account.ts"` to
  `package.json`.

- [ ] **Step 5: Run focused tests**

  Run: `pnpm test -- auth.service.spec.ts`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/users src/auth/entities/auth-session.entity.ts src/database/seed-development-account.ts package.json test/unit/auth/auth.service.spec.ts
  git commit -m "feat: add credential and refresh session models"
  ```

## Task 3: Implement Login, Refresh Rotation, and JWT Guard

**Files:**
- Create: `nest-langchain/src/auth/auth.module.ts`
- Create: `nest-langchain/src/auth/auth.controller.ts`
- Create: `nest-langchain/src/auth/auth.service.ts`
- Create: `nest-langchain/src/auth/auth.guard.ts`
- Create: `nest-langchain/src/auth/auth-user.decorator.ts`
- Create: `nest-langchain/src/auth/dto/login.dto.ts`
- Create: `nest-langchain/src/auth/types/auth-user.type.ts`
- Modify: `nest-langchain/src/app.module.ts`
- Modify: `nest-langchain/src/main.ts`
- Test: `nest-langchain/test/unit/auth/auth.service.spec.ts`
- Test: `nest-langchain/test/unit/auth/auth.guard.spec.ts`

- [ ] **Step 1: Add failing login and guard tests**

  Cover successful login, generic invalid credentials, disabled user, refresh rotation,
  refresh replay, and stale token version:

  ```ts
  await expect(service.login({ account: 'dev', password: 'wrong' }))
    .rejects.toThrow(new UnauthorizedException('账号或密码错误'));

  await expect(guard.canActivate(context)).resolves.toBe(false);
  expect(response.status).toHaveBeenCalledWith(401);
  ```

- [ ] **Step 2: Run auth tests**

  Run: `pnpm test -- auth.service.spec.ts auth.guard.spec.ts`

  Expected: FAIL because the module, service, and guard are absent.

- [ ] **Step 3: Implement token contracts**

  Define:

  ```ts
  export type AuthUser = { id: number; account: string; tokenVersion: number };
  export type AccessPayload = { sub: number; account: string; tokenVersion: number; type: 'access' };
  export type RefreshPayload = AccessPayload & { jti: string; type: 'refresh' };
  ```

  `AuthService.login()` compares bcrypt hashes, rejects non-active users, updates
  `lastLoginAt`, creates an `AuthSession`, and returns `{ accessToken, user,
  refreshToken }`. Access token TTL is `JWT_ACCESS_TTL` with default `15m`;
  refresh TTL defaults to `30d`.

  `refresh()` verifies the refresh signing secret and token type, looks up the session,
  compares its bcrypt hash, verifies user status/version, revokes the previous
  session, and issues a replacement. If a revoked session token is presented,
  revoke all user sessions and increment `tokenVersion` before returning 401.

- [ ] **Step 4: Implement controller and cookies**

  `POST /auth/login` and `POST /auth/refresh` set:

  ```ts
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: config.get('AUTH_COOKIE_SECURE') === 'true',
    sameSite: 'lax',
    path: '/auth',
    maxAge: refreshTtlMilliseconds,
  });
  ```

  Return only `{ accessToken, user }` JSON. `POST /auth/logout` revokes the session
  from the cookie and calls `res.clearCookie('refresh_token', { path: '/auth' })`.
  `GET /auth/me` returns the minimal public user projection.

  Apply `@Throttle({ default: { limit: 5, ttl: 60_000 } })` to login and
  `@Throttle({ default: { limit: 20, ttl: 60_000 } })` to refresh.

- [ ] **Step 5: Implement global access guard**

  Add a `@Public()` metadata decorator. The guard permits public routes, extracts
  exactly one bearer token, verifies it with the access secret, requires
  `payload.type === 'access'`, calls `findAuthUserById`, and attaches:

  ```ts
  request.user = { id: user.id, account: user.account, tokenVersion: user.tokenVersion };
  ```

  Reject missing, expired, disabled, or version-mismatched tokens with 401.
  Register the guard with `APP_GUARD`; decorate `POST /video/callback` public.

- [ ] **Step 6: Configure HTTP bootstrap**

  In `main.ts`, call `app.use(cookieParser())`, enable a global `ValidationPipe`
  with `whitelist: true` and `transform: true`, and replace wildcard CORS with:

  ```ts
  app.enableCors({
    origin: config.getOrThrow<string>('CORS_ORIGIN').split(','),
    credentials: true,
  });
  ```

- [ ] **Step 7: Run auth tests**

  Run: `pnpm test -- auth.service.spec.ts auth.guard.spec.ts`

  Expected: PASS.

- [ ] **Step 8: Commit**

  ```bash
  git add src/auth src/app.module.ts src/main.ts test/unit/auth
  git commit -m "feat: add JWT login and refresh sessions"
  ```

## Task 4: Enforce Ownership on Video Resources

**Files:**
- Modify: `nest-langchain/src/video/video.controller.ts`
- Modify: `nest-langchain/src/video/video.service.ts`
- Modify: `nest-langchain/src/video/video-task.service.ts`
- Test: `nest-langchain/test/unit/video/video.service.spec.ts`
- Test: `nest-langchain/test/unit/video/video-task.service.spec.ts`

- [ ] **Step 1: Write cross-user regression tests**

  Add cases for session history, assets, scripts, task lookup/cancel/list, and
  generated video creation:

  ```ts
  await expect(service.findHistoryBySessionId('session-a', 2))
    .resolves.toEqual([]);
  expect(messageRepo.find).toHaveBeenCalledWith({
    where: { sessionId: 'session-a', userId: 2 },
    order: { createdAt: 'ASC' },
  });
  ```

  A wrong user attempting an existing asset/task must produce the controller’s 404
  behavior, not return the record.

- [ ] **Step 2: Run video ownership tests**

  Run: `pnpm test -- video.service.spec.ts video-task.service.spec.ts`

  Expected: FAIL because current services accept unscoped IDs.

- [ ] **Step 3: Remove client-controlled user IDs from controller contracts**

  Inject `@CurrentUser() user: AuthUser` into every protected `VideoController`
  method. Delete all `user_id` request body/query fields. Pass `user.id` into
  `streamChat`, `findHistoryBySessionId`, asset methods, script methods, all task
  methods, and `findSessionsByUserId`.

  Keep only:

  ```ts
  @Public()
  @Post('callback')
  async handleCallback(...) { /* existing VIDEO_CALLBACK_TOKEN validation */ }
  ```

- [ ] **Step 4: Scope service methods and remove fallback user**

  Change `ensureSession(sessionId, userId)` to first search
  `{ sessionId, userId }`; if the session ID exists under a different owner, return
  not found instead of creating a second record. Delete `FALLBACK_USER_ID`.

  Make every repository `where` include `userId`, including:

  ```ts
  { sessionId, userId }
  { id: assetId, userId }
  { id: scriptId, userId }
  { taskId, userId }
  ```

  Include `userId` in `buildSystemPrompt` asset queries, referenced script lookup,
  `touchSession`, profile/status updates, and all task-service `findOne` calls.

- [ ] **Step 5: Run video ownership tests**

  Run: `pnpm test -- video.service.spec.ts video-task.service.spec.ts`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/video test/unit/video
  git commit -m "fix: scope video resources to authenticated users"
  ```

## Task 5: Enforce Ownership on OSS Records and Secure TTS WebSocket

**Files:**
- Modify: `nest-langchain/src/oss/entities/oss.entity.ts`
- Modify: `nest-langchain/src/oss/oss.controller.ts`
- Modify: `nest-langchain/src/oss/oss.service.ts`
- Modify: `nest-langchain/src/main.ts`
- Test: `nest-langchain/test/unit/oss/oss.service.spec.ts`

- [ ] **Step 1: Write failing OSS ownership tests**

  Add tests for list, get, upload, and delete:

  ```ts
  await service.findOne(42, 7);
  expect(repo.findOneBy).toHaveBeenCalledWith({ id: 42, userId: 7 });

  await expect(service.remove(42, 8)).resolves.toBeNull();
  ```

- [ ] **Step 2: Run OSS tests**

  Run: `pnpm test -- oss.service.spec.ts`

  Expected: FAIL because `OssFile` and `OssService` do not accept user IDs.

- [ ] **Step 3: Add OSS ownership**

  Add `userId` mapped to `oss_files.user_id`. Make `uploadFile`, `findAll`,
  `findOne`, and `remove` require a `userId`; write it for user uploads and video
  transfers. Pass `user.id` from `OssController`. Return `null` for non-owned IDs
  and convert that result to `NotFoundException` in the controller.

- [ ] **Step 4: Authenticate TTS WebSocket setup**

  Extract the JWT access token from the `Sec-WebSocket-Protocol` value, verify it
  using `AuthService.verifyAccessToken`, reject failures with HTTP 401 before
  registering the client, and associate the validated user ID with the relay client.
  Do not accept tokens from a URL query string.

- [ ] **Step 5: Run OSS tests**

  Run: `pnpm test -- oss.service.spec.ts`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/oss src/main.ts test/unit/oss
  git commit -m "fix: scope OSS files to authenticated users"
  ```

## Task 6: Add Frontend Authentication State and Login UI

**Files:**
- Create: `agui-frontend/src/auth/auth-api.ts`
- Create: `agui-frontend/src/auth/AuthProvider.tsx`
- Create: `agui-frontend/src/auth/RequireAuth.tsx`
- Create: `agui-frontend/src/pages/Login/index.tsx`
- Create: `agui-frontend/src/pages/Login/style.css`
- Modify: `agui-frontend/src/main.tsx`
- Modify: `agui-frontend/src/App.tsx`
- Modify: `agui-frontend/vite.config.ts`

- [ ] **Step 1: Create auth transport types**

  Define:

  ```ts
  export type AuthUser = {
    id: number
    account: string
    name: string | null
    nickname: string | null
    avatarUrl: string | null
    status: 'active'
  }
  export type AuthResponse = { accessToken: string; user: AuthUser }
  ```

  `login()` sends JSON credentials. `refresh()` and `logout()` use
  `credentials: 'include'` so browser cookies are sent.

- [ ] **Step 2: Implement the provider**

  Hold `accessToken`, `user`, `isLoading`, and `refresh()` in context. Call
  `refresh()` once on mount. Use a module-level `refreshPromise` so simultaneous
  expired requests share one refresh request. Clear state on refresh failure.

- [ ] **Step 3: Implement approved login screen**

  Build a semantic `<main>` split layout:

  ```tsx
  <section className="login-preview">...</section>
  <section className="login-panel">
    <Form onFinish={handleLogin}>
      <Form.Item name="account" rules={[{ required: true, message: '请输入账号' }]} />
      <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]} />
      <Button htmlType="submit" loading={isSubmitting}>登录</Button>
    </Form>
  </section>
  ```

  The preview uses the Lingjian mark, workspace framing, indigo primary action, and
  cyan agent indicator from the approved direction. Do not add registration or
  password recovery links. On success, navigate to the saved `from` location or
  `/life-video`.

- [ ] **Step 4: Add routing and Vite proxy**

  Wrap routes in `AuthProvider`, add public `/login`, and nest `/life-video` under
  `RequireAuth`. Add `'/auth': 'http://localhost:3000'` to Vite’s dev proxy.

- [ ] **Step 5: Run frontend static checks**

  Run:

  ```bash
  cd /Users/susucain/开发/agui-project/agui-frontend
  pnpm lint
  pnpm build
  ```

  Expected: both commands pass.

- [ ] **Step 6: Commit**

  ```bash
  git add src/auth src/pages/Login src/main.tsx src/App.tsx vite.config.ts
  git commit -m "feat: add workspace preview login page"
  ```

## Task 7: Attach Access Tokens to Video APIs and Replace EventSource

**Files:**
- Create: `agui-frontend/src/lib/api-fetch.ts`
- Modify: `agui-frontend/src/pages/VideoStoryboard/api.ts`
- Modify: `agui-frontend/src/pages/VideoStoryboard/index.tsx`

- [ ] **Step 1: Implement authenticated API wrapper**

  `apiFetch(input, init)` gets the access token from the provider bridge, sets
  `Authorization`, and retries exactly once after a failed `401`:

  ```ts
  const first = await fetch(input, withAuthorization(init, accessToken))
  if (first.status !== 401) return first
  const refreshed = await refreshAccessToken()
  return refreshed
    ? fetch(input, withAuthorization(init, getAccessToken()))
    : first
  ```

  The caller converts final 401 responses to the login redirect via the provider.

- [ ] **Step 2: Remove all frontend `user_id` and fallback-user use**

  Delete `FALLBACK_USER_ID` from `VideoStoryboard/index.tsx`. Delete `userId`
  arguments and `user_id` fields from `VideoStoryboard/api.ts`, `CreateAssetBody`,
  `GenerateVideoBody`, chat transport payloads, and every call site.

- [ ] **Step 3: Replace native EventSource**

  Implement `subscribeTaskStatus()` with `apiFetch` and `ReadableStream`:

  ```ts
  const response = await apiFetch(`${BASE}/generate/${taskId}/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  })
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader()
  ```

  Buffer lines until a blank line, parse `data:` JSON payloads, call `onUpdate`, and
  stop on terminal statuses or abort. This preserves bearer auth without placing JWT
  in a URL.

- [ ] **Step 4: Run frontend validation**

  Run:

  ```bash
  pnpm lint
  pnpm build
  ```

  Expected: both commands pass.

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/api-fetch.ts src/pages/VideoStoryboard
  git commit -m "fix: authenticate video API and task streams"
  ```

## Task 8: Verify End-to-End Security and Release Readiness

**Files:**
- Modify: `nest-langchain/test/app.e2e-spec.ts`
- Modify: `nest-langchain/DEPLOYMENT.md`
- Modify: `agui-frontend/README.md`

- [ ] **Step 1: Add e2e auth/ownership test sequence**

  Use two seeded test users. Assert:

  ```ts
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ account: 'dev', password: testPassword })
    .expect(201)

  await request(app.getHttpServer())
    .get('/video/history/user-one-session')
    .set('Authorization', `Bearer ${userTwoToken}`)
    .expect(404)
  ```

  Also assert missing JWT returns 401, refresh returns a new access token and cookie,
  logout invalidates the current refresh session, and `/video/callback` still accepts
  only a valid callback token.

- [ ] **Step 2: Run backend verification**

  Run:

  ```bash
  cd /Users/susucain/开发/agui-project/nest-langchain
  pnpm test
  pnpm test:e2e
  pnpm build
  ```

  Expected: all pass. If the e2e suite needs external MySQL/Redis/OSS, run it against
  the documented compose test environment and record that prerequisite in the test
  output.

- [ ] **Step 3: Perform browser smoke test**

  Run the frontend with the API and verify:

  1. Unauthenticated `/life-video` routes to `/login`.
  2. `dev` login opens the existing user-1 sessions.
  3. Refreshing the browser preserves the authenticated session.
  4. A second account cannot fetch or mutate user-1 assets, scripts, tasks, or OSS files.
  5. Logout returns to `/login`; direct workspace navigation remains blocked.

- [ ] **Step 4: Document operational requirements**

  Add deployment instructions covering migration backup, required JWT secrets,
  `CORS_ORIGIN`, proxy `/auth`, the opt-in development seed, and the prohibition on
  `SEED_DEV_ACCOUNT=true` in production.

- [ ] **Step 5: Commit**

  ```bash
  git add test/app.e2e-spec.ts DEPLOYMENT.md
  git commit -m "test: verify authenticated workspace access"
  ```

  Then commit frontend operational documentation from its own repository:

  ```bash
  cd /Users/susucain/开发/agui-project/agui-frontend
  git add README.md
  git commit -m "docs: describe authenticated frontend setup"
  ```
