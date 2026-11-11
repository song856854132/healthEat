# @healtheat/api

Express 5 REST API, deployed as one Vercel function (zero-config Express; entry `src/app.ts`).

## Environment

| Variable         | Required                                           | Where it comes from                                                                                                                                    |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MONGODB_URI`    | for every database route (health works without it) | one Atlas M0 cluster for all environments; Secret Manager `mongodb-uri-staging` (dev VM via `~/.env.staging`), Vercel env (preview, production)        |
| `MONGODB_DB`     | no (default `healtheat_dev`)                       | selects the database on that cluster: `healtheat_prod`, `healtheat_staging` (set by the staging workflow), `healtheat_preview`, `healtheat_dev_<user>` |
| `SESSION_SECRET` | yes in production                                  | Secret Manager `session-secret-staging`, Vercel env                                                                                                    |
| `PORT`           | no (4000)                                          | local only                                                                                                                                             |

Routes answer `503 {error: "database_unconfigured"}` when `MONGODB_URI` is unset and
`503 {error: "database_unavailable"}` when Atlas does not answer within 5 seconds (Mongoose
`serverSelectionTimeoutMS`). `GET /api/health` reports `db` without forcing a connection.

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
src/middleware/       error handler (always JSON, never a stack), notFound
src/models/           Mongoose models: User, MemberProfile, CuratorProfile, AdminProfile
src/routes/           one router per resource; routers never touch fetch or process.env
test/setup.ts         mongodb-memory-server per worker, collections cleared after each test
```
