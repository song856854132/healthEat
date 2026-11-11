# @healtheat/api

Express 5 REST API, deployed as one Vercel function (zero-config Express; entry `src/app.ts`).

## Environment

| Variable         | Required                                                           | Where it comes from                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MONGODB_URI`    | for every database route (health works without it)                 | one Atlas M0 cluster for all environments; Secret Manager `mongodb-uri-staging` (dev VM via `~/.env.staging`), Vercel env (preview, production)        |
| `MONGODB_DB`     | on every Vercel deployment (local runs default to `healtheat_dev`) | selects the database on that cluster: `healtheat_prod`, `healtheat_staging` (set by the staging workflow), `healtheat_preview`, `healtheat_dev_<user>` |
| `SESSION_SECRET` | on every Vercel deployment (preview, staging and production)       | Secret Manager `session-secret-staging`, Vercel env                                                                                                    |
| `PORT`           | no (4000)                                                          | local only                                                                                                                                             |

Failure modes, all JSON:

| Response                                    | Meaning                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `503 {error: "database_unconfigured"}`      | `MONGODB_URI` is unset                                                                                            |
| `503 {error: "database_misconfigured"}`     | `MONGODB_URI` is present but not a `mongodb://` or `mongodb+srv://` URI, or `MONGODB_DB` is unset on a deployment |
| `503 {error: "database_unavailable"}`       | Atlas did not answer within 5 seconds (Mongoose `serverSelectionTimeoutMS`), or the connection dropped            |
| `503 {error: "secret_unconfigured"}`        | a deployment is running with the development `SESSION_SECRET` placeholder; only `/api/health` keeps answering     |
| `400 invalid_json`, `413 payload_too_large` | body-parser client errors keep their own status; they are never logged as server errors                           |

`GET /api/health` never forces a connection and reports `db` (`connected`, `connecting`, `disconnected`,
`unconfigured`, `misconfigured`), the non-secret `dbName`, and `secrets` (`ok` or `missing`).
`GET /api/health/db` forces a live connection and is what the staging smoke checks. Details on 5xx
responses are redacted on every deployment (`isDeployed()`), shown only on local runs.

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
