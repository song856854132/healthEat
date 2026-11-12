# @healtheat/api

Express 5 REST API, deployed as one Vercel function (zero-config Express; entry `src/app.ts`).

## Environment

| Variable          | Required                                                           | Where it comes from                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`     | for every database route (health works without it)                 | one Atlas M0 cluster for all environments; Secret Manager `mongodb-uri-staging` (dev VM via `~/.env.staging`), Vercel env (preview, production)                                                                                                       |
| `MONGODB_DB`      | on every Vercel deployment (local runs default to `healtheat_dev`) | selects the database on that cluster: `healtheat_prod`, `healtheat_staging` (set by the staging workflow), `healtheat_preview`, `healtheat_dev_<user>`                                                                                                |
| `SESSION_SECRET`  | on every Vercel deployment (preview, staging and production)       | signs the `he_sid` session cookie (express-session); Secret Manager `session-secret-staging`, Vercel env                                                                                                                                              |
| `ADMIN_USERNAMES` | no                                                                 | comma-separated usernames that hold `admin` (design doc D10): granted at login (a listed username cannot register), authoritative (a revoked listed admin regains it at the next login). Vercel env: `demo_admin` on preview (staging) and production |
| `PORT`            | no (4000)                                                          | local only                                                                                                                                                                                                                                            |

Failure modes, all JSON:

| Response                                    | Meaning                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `503 {error: "database_unconfigured"}`      | `MONGODB_URI` is unset                                                                                                                                                  |
| `503 {error: "database_misconfigured"}`     | `MONGODB_URI` is present but not a `mongodb://` or `mongodb+srv://` URI, or `MONGODB_DB` is unset on a deployment                                                       |
| `503 {error: "database_unavailable"}`       | Atlas did not answer within 5 seconds (Mongoose `serverSelectionTimeoutMS`), or the connection dropped                                                                  |
| `503 {error: "secret_unconfigured"}`        | a deployment is running with the development `SESSION_SECRET` placeholder; only the `/api/health` routes (`/api/health`, `/api/health/db`) keep answering               |
| `400 invalid_json`, `413 payload_too_large` | body-parser client errors keep their own status; they are never logged as server errors                                                                                 |
| `400 {error: "validation_error", details}`  | zod or Mongoose validation failed; `details` lists the offending paths                                                                                                  |
| `400 {error: "invalid_id"}`                 | a malformed ObjectId (Mongoose `CastError`)                                                                                                                             |
| `409 {error: "conflict", details.fields}`   | duplicate key (unique index), for example a taken username or email                                                                                                     |
| `401 {error: "unauthenticated"}`            | no session cookie, or a session whose account no longer exists (the session is destroyed)                                                                               |
| `401 {error: "invalid_credentials"}`        | login with an unknown username or a wrong password; both cost one bcrypt compare and return this same body                                                              |
| `403 {error: "account_suspended"}`          | `status` is not `active`: login refused, and an existing session is destroyed on its next request                                                                       |
| `403 {error: "account_deletion_pending"}`   | `deletionPending` is set (T5 cascade in progress); same handling as suspended                                                                                           |
| `409 {error: "username_reserved"}`          | `POST /api/auth/register` with a username listed in `ADMIN_USERNAMES`: a listed name is never claimable through open registration; create the account before listing it |
| `409 {error: "cannot_revoke_own_admin"}`    | an admin tried to remove `admin` from their own account (prevents locking every admin out)                                                                              |
| `409 {error: "last_admin"}`                 | the change would leave no admin at all (checked before and after the write, so two admins demoting each other cannot both win)                                          |
| `409 {error: "roles_changed"}`              | another admin changed the same account's roles between this request's read and write; reload and retry                                                                  |
| `404 {error: "not_found"}` (admin routes)   | `PUT /api/admin/users/:username/roles` named an unknown username                                                                                                        |
| `403 {error: "forbidden"}`                  | the account does not hold the role a route needs (`requireRole` checks `roles`, never `activeRole`), or asks for an active role it does not hold                        |
| `500 {error: "internal"}`                   | anything else; logged with its stack, `details` only on local runs                                                                                                      |

`GET /api/health` never forces a connection and reports `db` (`connected`, `connecting`, `disconnected`,
`unconfigured`, `misconfigured`), the non-secret `dbName`, and `secrets` (`ok` or `missing`).
`GET /api/health/db` forces a live connection and answers `503 database_unavailable` unless the
connection state is `connected` (a cached promise that survived a drop never yields a 200); the staging
and release smokes check it together with `secrets: "ok"` on `/api/health`. Details on 5xx
responses are redacted on every deployment (`isDeployed()`), shown only on local runs.

## Auth and sessions

| Route                                  | Body (zod schema in `@healtheat/shared`) | Answer                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/register`              | `RegisterInput`                          | `201 MeResponse`; creates `User` + `MemberProfile` (timezone canonicalised), starts a session                                                                                                                                                                                                                                    |
| `POST /api/auth/login`                 | `LoginInput`                             | `200 MeResponse`; fresh session id on every login                                                                                                                                                                                                                                                                                |
| `POST /api/auth/logout`                | none                                     | `200 {ok: true}`; destroys the session and clears `he_sid` (idempotent)                                                                                                                                                                                                                                                          |
| `GET /api/auth/me`                     | none                                     | `200 MeResponse` (`user` fields plus which role profiles exist)                                                                                                                                                                                                                                                                  |
| `PUT /api/users/me/active-role`        | `ActiveRoleInput`                        | `200 MeResponse`; the role must be in `roles` (else `403 forbidden`); mirrored into the session                                                                                                                                                                                                                                  |
| `PUT /api/admin/users/:username/roles` | `RoleUpdateInput` (admin only)           | `200 MeResponse` of the target; the complete role set (must include `member`). A grant upserts the role's empty profile; a revoke keeps the profile and resets `activeRole` to `member` if it was active (the target's session follows on its next request). Each change counts in the acting admin's `AdminProfile.grantsCount` |

Sessions: `express-session` + `connect-mongo`, collection `sessions` in the same database, 14-day TTL,
rolling, written at most once a day per session (`touchAfter`). Cookie `he_sid`: `HttpOnly`, `SameSite=Lax`,
`Secure` on every deployment, no domain (same origin through the Next.js rewrite). Session data is
`{userId, activeRole}`, stored as a document (not a JSON string) so T5 can delete a user's sessions by
`session.userId`. Passwords: `bcryptjs` cost 12 (pure JavaScript: no native module to build for the
function's architecture); never returned (`passwordHash` has `select: false`).

Privacy acknowledgment: the banner sets the readable cookie `he_privacy_ack` (1 year, `SameSite=Lax`).
Register and login copy it to `User.privacyAckAt` when present, and set it when the account already has
`privacyAckAt` (new device). `MeResponse.user.privacyAckAt` tells the web whether to show the banner.

Session-backed routers are mounted as `requireDb, sessionMiddleware(), router`: a database that does not
answer gives `503 database_unavailable` before the session store is touched. `/api/health` and the spike
routes never open a session.

## Run and test

```bash
set -a; . ~/.env.staging; set +a      # on the VM; locally use .env.example values
npm run dev -w @healtheat/api         # http://localhost:4000/api/health
npx vitest run --project api          # tests start an in-memory MongoDB per worker
```

The first test run downloads a MongoDB binary (about 100 MB, cached in `~/.cache/mongodb-binaries`).
On an Ubuntu release the downloader does not know yet (26.04 today), set `MONGOMS_DISTRO=ubuntu-2404`.

## Layout

```
src/app.ts            Express app (deployable entry); src/index.ts adds listen for local dev
src/lib/env.ts        the only reader of process.env (zod-validated)
src/lib/db.ts         connectDb (cached on globalThis), dbState, requireDb
src/lib/http.ts       HttpError, asyncHandler
src/lib/session.ts    express-session + connect-mongo (cookie he_sid, collection sessions), built behind requireDb
src/lib/password.ts   bcryptjs cost 12: hashPassword, verifyPassword, DUMMY_HASH for unknown usernames
src/lib/process.ts    unhandledRejection (log, keep serving) and uncaughtException (log, exit) hooks
src/middleware/       error handler (always JSON, never a stack), notFound, secretsGuard (503 secret_unconfigured),
                      requireAuth (401/403, loads the account), requireRole(role) (403 forbidden)
src/models/           Mongoose models: User, MemberProfile, CuratorProfile, AdminProfile
src/services/auth.ts  register (user + member profile, rerunnable), login (constant-cost), me, setActiveRole
src/services/roles.ts setRoles (admin route: atomic conditional role write, lockout guards), applyAdminBootstrap (ADMIN_USERNAMES)
src/routes/           one router per resource (health, spike, auth, users, admin); routers never touch fetch or process.env
test/setup.ts         mongodb-memory-server per worker, collections cleared after each test
```
