# Login UI and JWT Authentication Design

## Goal

Add account/password login to the Lingjian AI video workspace. The first release does
not expose registration or password recovery, but its account model and services must
support future self-service registration. JWT is the authentication mechanism.

Existing data owned by `users.id = 1` remains available through an authenticated
development account. User `1` is never used as an unauthenticated fallback.

## Login UI

Use the approved "workspace preview" layout:

- Desktop split layout. The left panel introduces Lingjian AI and displays a restrained
  preview of the creation workspace; the right panel is the login form.
- Match the existing workspace visual language: white canvas, cool-gray dividers,
  indigo primary action (`#5145e9`), cyan status accent, 6-8px control radius, and
  compact operational typography.
- Form fields: account, password, submit button. Show loading, required-field,
  invalid-credential, and network-error states.
- There are no registration or password-recovery actions in this release.
- `/login` is public. An unauthenticated workspace request redirects to `/login`;
  an authenticated `/login` request redirects to `/life-video`.

## Architecture

Create an `AuthModule` owning credential verification, JWT issuance, refresh-session
rotation, and current-user retrieval. `UsersModule` remains responsible for user
records. Use `@nestjs/jwt` for token signing and verification and `bcrypt` for
password hashes.

### Tokens

| Token | Transport | Lifetime | Claims |
| --- | --- | --- | --- |
| Access JWT | Login/refresh JSON response; React memory only | 15 minutes | `sub`, `account`, `tokenVersion`, `type=access` |
| Refresh JWT | `HttpOnly`, `Secure`, `SameSite=Lax`, path `/auth` cookie | 30 days | `sub`, `jti`, `tokenVersion`, `type=refresh` |

The access JWT is included in `Authorization: Bearer <token>` for API calls. It is
not stored in local storage or session storage. On application startup, the frontend
calls `/auth/refresh`; its refresh cookie allows the server to issue a new access
JWT. An API wrapper retries a single 401 response after refresh, then clears local
auth state and routes to `/login`.

JWT validation loads the user and verifies `status === "active"` and
`token_version` equality. This makes account disabling, password changes, and
global sign-out effective immediately. Redis caching of this small auth lookup is an
optional later optimization, not a first-release requirement.

## Data Model and Migration

Use TypeORM migrations for this change. Do not rely on `synchronize: true` in
production.

### `users`

Add:

| Column | Definition | Notes |
| --- | --- | --- |
| `account` | `varchar(64)`, unique, not null | Account login identifier |
| `password_hash` | `varchar(255)`, not null | bcrypt hash only |
| `token_version` | `int`, not null, default 0 | Invalidates issued tokens |

Keep existing `email`, Douyin IDs, nickname, avatar, status, and login timestamp.
`email` remains profile data in this release.

The migration must preserve numeric user IDs. It backfills user `1` with a configured
development account without changing its primary key, so all existing video records
where `user_id = 1` keep their owner. Other legacy user rows require explicit account
credentials through the administrator provisioning path before they can log in.

### `auth_sessions`

Create:

| Column | Definition |
| --- | --- |
| `id` | UUID primary key / refresh JWT `jti` |
| `user_id` | indexed foreign key to `users.id` |
| `refresh_token_hash` | bcrypt hash of the refresh JWT |
| `expires_at` | datetime |
| `revoked_at` | nullable datetime |
| `last_used_at` | nullable datetime |
| `created_at`, `updated_at` | timestamps |

Never persist plaintext refresh tokens. Refreshing an active session creates a
replacement session and revokes the former one. Reusing a revoked refresh token is
treated as replay: revoke all user sessions and increment `token_version`.

### Development Account

Provide an idempotent seed command that only runs when
`SEED_DEV_ACCOUNT=true`. It creates user `1` if missing, or backfills its credentials
if present.

- Default account name: `dev` (overridable with `DEV_ACCOUNT`).
- Password comes only from `DEV_ACCOUNT_PASSWORD`; the command fails if unset.
- Production may run the command only through this explicit deployment opt-in; it does
  not contain a default development credential.

## API Contract

### Public Authentication Endpoints

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /auth/login` | `{ account, password }` | `{ accessToken, user }`; sets refresh cookie |
| `POST /auth/refresh` | Cookie only | `{ accessToken, user }`; rotates refresh cookie |
| `POST /auth/logout` | Cookie only | `204`; revokes current session and clears cookie |
| `GET /auth/me` | Access JWT | `{ id, account, name, nickname, avatarUrl, status }` |

Credential failures always return the same 401 response, `"账号或密码错误"`.
Validation errors return 400. Login and refresh apply account/IP rate limits.

### Protected Application Endpoints

Apply a global JWT guard and mark only login, refresh, logout, and
`POST /video/callback` as public. The video callback continues to validate
`VIDEO_CALLBACK_TOKEN`.

For all protected handlers, the server derives `userId` from `req.user.sub`.
Remove `user_id` from video DTOs, query strings, and frontend request bodies.
The service layer passes that ID through all operations and scopes:

- sessions and chat history
- video assets, scripts, generated tasks, retrieval, update, and delete
- video task status and task lists
- OSS upload records, lists, detail lookup, and delete

Add `user_id` to the OSS file entity and backfill existing files to the matching
development user as appropriate. A record not owned by the current user returns 404
to avoid resource enumeration.

The existing public `/users` CRUD endpoints are removed from normal client use. The
first release exposes only `/auth/me`; future administration needs a separately
authorized role and management controller.

### Streams and WebSocket

Native `EventSource` cannot attach the Authorization header. Replace the task-status
subscription with `fetch` plus a streaming SSE parser so it uses the same access JWT
as every other video request. Do not place JWTs in query strings.

The speech WebSocket verifies a short-lived access JWT transmitted through
`Sec-WebSocket-Protocol` during connection setup. The server rejects absent, expired,
disabled, or token-version-mismatched users.

## Configuration and Deployment

Add the following deployment secrets/configuration:

```dotenv
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
AUTH_COOKIE_SECURE=true
CORS_ORIGIN=https://app.example.com
DEV_ACCOUNT=dev
DEV_ACCOUNT_PASSWORD=
SEED_DEV_ACCOUNT=false
```

Access and refresh secrets are separate, high-entropy values injected through the
deployment secret manager. In production the frontend and API are served through the
same reverse-proxy origin. Development Vite proxy adds `/auth`. Replace
`origin: "*"` with the configured application origin; only enable CORS credentials
when a cross-origin deployment is deliberately configured.

## Error Handling

- Missing/expired access token: 401.
- Valid token with disabled user or stale `token_version`: 401.
- Valid token attempting another user's resource: 404.
- Invalid refresh token: clear cookie and return 401.
- Database or provider errors: log correlation details server-side; return a safe 5xx
  response without credential or token content.

## Verification

Backend unit/e2e coverage:

- bcrypt password hashing and credential validation
- successful, invalid, and disabled-account login
- refresh rotation, logout, and revoked-refresh replay detection
- `token_version` invalidation after password change and global sign-out
- guard rejection for missing/invalid JWT
- cross-user denial for every video and OSS read/mutation
- callback token remains valid without JWT

Frontend coverage:

- login success, validation, server 401, and network errors
- protected-route redirect and authenticated redirect away from `/login`
- initial refresh, one-time API retry, then logout on persistent 401
- authenticated SSE task status subscription

## Rollout

1. Add migrations, entities, environment validation, and the development-account
   seed command. Back up the database before production migration.
2. Deploy `AuthModule`, guards, ownership-scoped video/OSS services, and request
   contract changes. Verify with development account `id=1`.
3. Deploy the login page, routing boundary, API wrapper, and authenticated SSE/WebSocket
   clients.
4. Remove temporary client-side `user_id` plumbing and validate that no endpoint uses
   an unauthenticated fallback user.
