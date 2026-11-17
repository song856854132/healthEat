# @healtheat/api

Express 5 REST API, deployed as one Vercel function (zero-config Express; entry `src/app.ts`).

## Environment

| Variable          | Required                                                           | Where it comes from                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`     | for every database route (health works without it)                 | one Atlas M0 cluster for all environments; Secret Manager `mongodb-uri-staging` (dev VM via `~/.env.staging`), Vercel env (preview, production)                                                                                                                                                                   |
| `MONGODB_DB`      | on every Vercel deployment (local runs default to `healtheat_dev`) | selects the database on that cluster: `healtheat_prod`, `healtheat_staging` (set by the staging workflow), `healtheat_preview`, `healtheat_dev_<user>`                                                                                                                                                            |
| `SESSION_SECRET`  | on every Vercel deployment (preview, staging and production)       | signs the `he_sid` session cookie (express-session); Secret Manager `session-secret-staging`, Vercel env                                                                                                                                                                                                          |
| `ADMIN_USERNAMES` | no                                                                 | comma-separated usernames that hold `admin` (design doc D10): granted at login (a listed username cannot register), authoritative (a revoked listed admin regains it at the next login). Vercel env: `demo_admin` on preview (staging) and production                                                             |
| `USDA_API_KEY`    | on every Vercel deployment that serves `/api/foods/*`              | api.data.gov key for USDA FoodData Central, server-side only. Local runs without it use the shared `DEMO_KEY` (a few requests an hour); a deployment without it answers `503 usda_unconfigured` on the food routes. Secret Manager `usda-api-key` (dev VM via `~/.env.staging`), Vercel env (preview, production) |
| `PORT`            | no (4000)                                                          | local only                                                                                                                                                                                                                                                                                                        |

Failure modes, all JSON:

| Response                                    | Meaning                                                                                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `503 {error: "database_unconfigured"}`      | `MONGODB_URI` is unset                                                                                                                                                                                          |
| `503 {error: "database_misconfigured"}`     | `MONGODB_URI` is present but not a `mongodb://` or `mongodb+srv://` URI, or `MONGODB_DB` is unset on a deployment                                                                                               |
| `503 {error: "database_unavailable"}`       | Atlas did not answer within 5 seconds (Mongoose `serverSelectionTimeoutMS`), or the connection dropped                                                                                                          |
| `503 {error: "secret_unconfigured"}`        | a deployment is running with the development `SESSION_SECRET` placeholder; only the `/api/health` routes (`/api/health`, `/api/health/db`) keep answering                                                       |
| `400 invalid_json`, `413 payload_too_large` | body-parser client errors keep their own status; they are never logged as server errors                                                                                                                         |
| `400 {error: "validation_error", details}`  | zod or Mongoose validation failed; `details` lists the offending paths                                                                                                                                          |
| `400 {error: "invalid_id"}`                 | a malformed ObjectId (Mongoose `CastError`)                                                                                                                                                                     |
| `409 {error: "conflict", details.fields}`   | duplicate key (unique index), for example a taken username or email                                                                                                                                             |
| `401 {error: "unauthenticated"}`            | no session cookie, or a session whose account no longer exists (the session is destroyed)                                                                                                                       |
| `401 {error: "invalid_credentials"}`        | login with an unknown username or a wrong password; both cost one bcrypt compare and return this same body                                                                                                      |
| `429 {error: "too_many_attempts"}`          | `POST /api/auth/login` after 10 failures for the same username and client IP within 15 minutes, even with the right password; `Retry-After` gives the seconds left                                              |
| `503 {error: "usda_unavailable"}`           | USDA answered 429, 5xx or 401/403, timed out (8 s) or was unreachable, and no stored copy exists; `details` is "USDA is unavailable right now, try again in a few minutes", on deployments too                  |
| `503 {error: "usda_unconfigured"}`          | a deployment without `USDA_API_KEY` received a food request                                                                                                                                                     |
| `404 {error: "food_not_found"}`             | `GET /api/foods/:fdcId` for an id USDA does not know and that was never stored                                                                                                                                  |
| `404 {error: "log_not_found"}`              | `PUT/DELETE /api/logs/:id` for an id that names no entry (also a malformed id)                                                                                                                                  |
| `400 {error: "date_in_future"}`             | `POST /api/users/me/logs` with a `date` after today in the member's time zone; `details` names the latest allowed date                                                                                          |
| `400 {error: "unknown_allergen"}`           | `PUT /api/users/me/allergens` with keys the dictionary does not hold; `details.keys` lists them, nothing is written                                                                                             |
| `404 {error: "allergen_not_found"}`         | `DELETE /api/allergens/:id` for an id that names no entry (also a malformed id)                                                                                                                                 |
| `403 {error: "account_suspended"}`          | `status` is not `active`: login refused, and an existing session is destroyed on its next request                                                                                                               |
| `403 {error: "account_deletion_pending"}`   | `deletionPending` is set (T5 cascade in progress); same handling as suspended, except that login with the right password first finishes the deletion (below)                                                    |
| `409 {error: "username_reserved"}`          | `POST /api/auth/register` with a username listed in `ADMIN_USERNAMES`: a listed name is never claimable through open registration; create the account before listing it                                         |
| `409 {error: "cannot_revoke_own_admin"}`    | an admin tried to remove `admin` from their own account (prevents locking every admin out)                                                                                                                      |
| `409 {error: "last_admin"}`                 | the change would leave no usable admin (active, not being deleted), checked before and after the write, so two admins demoting each other cannot both win; also `DELETE /api/users/me` by the only usable admin |
| `409 {error: "roles_changed"}`              | another admin changed the same account's roles between this request's read and write; reload and retry                                                                                                          |
| `404 {error: "not_found"}` (admin routes)   | `PUT /api/admin/users/:username/roles` named an unknown username                                                                                                                                                |
| `403 {error: "forbidden"}`                  | the account does not hold the role a route needs (`requireRole` checks `roles`, never `activeRole`), asks for an active role it does not hold, or edits a log entry that is not its own                         |
| `500 {error: "internal"}`                   | anything else; logged with its stack, `details` only on local runs                                                                                                                                              |

`GET /api/health` never forces a connection and reports `db` (`connected`, `connecting`, `disconnected`,
`unconfigured`, `misconfigured`), the non-secret `dbName`, and `secrets` (`ok` or `missing`).
`GET /api/health/db` forces a live connection and answers `503 database_unavailable` unless the
connection state is `connected` (a cached promise that survived a drop never yields a 200); the staging
and release smokes check it together with `secrets: "ok"` on `/api/health`. Details on 5xx
responses are redacted on every deployment (`isDeployed()`), shown only on local runs, unless the
`HttpError` was raised with `expose: true` because its details are written for users (today only
`usda_unavailable`).

## Auth and sessions

| Route                                  | Body (zod schema in `@healtheat/shared`)                                                                        | Answer                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/register`              | `RegisterInput`                                                                                                 | `201 MeResponse`; creates `User` + `MemberProfile` (timezone canonicalised), starts a session                                                                                                                                                                                                                                                                             |
| `POST /api/auth/login`                 | `LoginInput`                                                                                                    | `200 MeResponse`; fresh session id on every login; throttled (below)                                                                                                                                                                                                                                                                                                      |
| `POST /api/auth/logout`                | none                                                                                                            | `200 {ok: true}`; destroys the session and clears `he_sid` (idempotent)                                                                                                                                                                                                                                                                                                   |
| `GET /api/auth/me`                     | none                                                                                                            | `200 MeResponse` (`user` fields plus which role profiles exist)                                                                                                                                                                                                                                                                                                           |
| `PUT /api/users/me/active-role`        | `ActiveRoleInput`                                                                                               | `200 MeResponse`; the role must be in `roles` (else `403 forbidden`); mirrored into the session                                                                                                                                                                                                                                                                           |
| `PUT /api/admin/users/:username/roles` | `RoleUpdateInput` (admin only)                                                                                  | `200 MeResponse` of the target; the complete role set (must include `member`). A grant upserts the role's empty profile; a revoke keeps the profile and resets `activeRole` to `member` if it was active (the target's session follows on its next request). Each change counts in the acting admin's `AdminProfile.grantsCount`                                          |
| `GET /api/foods/search`                | query `FoodSearchQuery` (`q`, `dataType?`, `page?`); public                                                     | `200 FoodSearchResponse`: 25 results per page with headline nutrients per 100 g; `cached: true` marks a stored page served because USDA failed                                                                                                                                                                                                                            |
| `GET /api/foods/:fdcId`                | none; public                                                                                                    | `200 FoodDetails`: every nutrient per 100 g, serving sizes in grams, brand owner and ingredients for branded foods, and `allergens[]` (`FoodAllergenMatch`: key, name, tier, `matchKind`, matched synonym); `cached` as for search                                                                                                                                        |
| `GET /api/allergens`                   | none; public                                                                                                    | `200 AllergenListResponse`: the whole allergen dictionary by display name (seeded on first use)                                                                                                                                                                                                                                                                           |
| `GET /api/users/me/logs`               | query `LogsQuery` (`from?`, `to?`, inclusive, at most 92 days; neither means today, one means that day); member | `200 LogListResponse`: the caller's entries by date, meal and time, each with the cached food's `description`                                                                                                                                                                                                                                                             |
| `POST /api/users/me/logs`              | `LogEntryCreateInput` (`fdcId`, `grams` up to 5000, `meal`, `date?`); member                                    | `201 LogEntryCreated`: the entry plus `alerts[]`, every avoid-mode allergen the food matched (any date, so a backfilled entry is flagged too). The food is fetched and matched first when uncached; `404 food_not_found` or `503 usda_unavailable` write nothing. `date` defaults to today in the member's time zone; a later date is `400 date_in_future`                |
| `PUT /api/logs/:id`                    | `LogEntryUpdateInput` (`grams` and/or `meal` only; a `date` or `fdcId` is 400); owner                           | `200 LogEntryView`                                                                                                                                                                                                                                                                                                                                                        |
| `DELETE /api/logs/:id`                 | none; owner                                                                                                     | `204`                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /api/users/me/allergens`          | none; member                                                                                                    | `200 UserAllergensResponse`: the caller's avoid and track settings by display name                                                                                                                                                                                                                                                                                        |
| `PUT /api/users/me/allergens`          | `UserAllergensInput` (the complete list: `key`, `mode?`, `weeklyThreshold?` for track mode); member             | `200 UserAllergensResponse`; replaces the stored list. `mode` defaults from the allergen's tier: sensitivity tracks, allergy and both avoid. A `weeklyThreshold` on a setting whose mode is `avoid`, sent or taken from the tier, is `400 validation_error` (path `allergens.N.weeklyThreshold`); an unknown key is `400 unknown_allergen`; a refused list writes nothing |
| `DELETE /api/users/me`                 | none; session                                                                                                   | `204`; deletes the account and everything it owns (T5 cascade below), ends every session of the account and clears the cookie; the only usable Admin gets `409 last_admin`                                                                                                                                                                                                |
| `DELETE /api/allergens/:id`            | none; curator                                                                                                   | `204`; removes the entry with its `FoodAllergen` and `UserAllergen` rows (no matching pass) and counts the edit on the `CuratorProfile`; a deleted seed entry stays deleted                                                                                                                                                                                               |

Sessions: `express-session` + `connect-mongo`, collection `sessions` in the same database, 14-day TTL,
rolling, written at most once a day per session (`touchAfter`). Cookie `he_sid`: `HttpOnly`, `SameSite=Lax`,
`Secure` on every deployment, no domain (same origin through the Next.js rewrite). Session data is
`{userId, activeRole}`, stored as a document (not a JSON string) so T5 can delete a user's sessions by
`session.userId`. Passwords: `bcryptjs` cost 12 (pure JavaScript: no native module to build for the
function's architecture); never returned (`passwordHash` has `select: false`).

Login throttle (design doc D7): `LoginAttempt {key, count, windowStart}` counts login attempts per
lowercased username plus `req.ip`. Each attempt is counted atomically before the bcrypt compare, so
unknown usernames and wrong passwords both count and a burst of parallel requests gets at most 10
compares. After 10 failures inside a 15-minute window that starts at the first one, login answers
`429 too_many_attempts` with `Retry-After` and no compare, even for the right password. A successful login
deletes the counter, and a TTL index on `windowStart` removes stale windows. The limit is per username
and client IP, with no ceiling per account. Through the Next.js rewrite, `req.ip` (`trust proxy` 1) may be
one shared Vercel hop, which makes the key effectively per username: anyone can then lock an account's
logins for up to 15 minutes. A client that calls the public API origin directly is keyed by its own IP,
so an attacker who rotates IPs gets 10 guesses per address.

USDA proxy (design doc D5, S7): `/api/foods/*` needs the database (for its caches) but no session.
A search page is stored in `searchcaches` (`SearchCache {key, payload, createdAt}`, key = lowercased
query, data type and page) and served without calling USDA for one hour; a TTL index deletes it after 24
hours. Opened foods are stored in `foods` (`Food`, unique `fdcId`) and re-fetched after 30 days; they are
never deleted, because log entries will point at them. When USDA fails, the stored copy is served with
`cached: true`; with nothing stored the route answers `503 usda_unavailable`. Search does not store the
foods on its result page; only a food someone opens is stored. A query USDA rejects (400) answers an
empty result page. A stored page or food that no longer matches the response shape is refetched. The
routes have no abuse limit yet (accepted risk, TODOS.md "Food routes: abuse limit and cache footprint").

Allergen dictionary and matcher (design doc: Allergen matching, D12; T11): `allergens` (`Allergen {key,
displayName, tier, synonyms, descriptionKeywords, excludePhrases, source, updatedBy}`) is seeded from
`ALLERGEN_SEED` (`packages/shared`, provenance in `packages/shared/data/PROVENANCE.md`) when it is first
read. A marker document (`dictionaryseeds`) lists the seed keys already written; any seed key missing
from it is upserted on the next read, so a partial first seed is finished and a later seed addition
reaches existing databases. The seed never overwrites an entry, and a seed entry a Curator deleted stays
deleted.
Each opened food is matched once per USDA copy and its rows are stored in `foodallergens` (`FoodAllergen
{fdcId, allergenId, matchKind, matchedSynonym, matchedAt}`, unique per food and allergen). The ingredient
text is split at commas, semicolons, colons, periods and brackets, and a synonym must match whole words
inside one ingredient (`ingredient`). The description is searched for `descriptionKeywords` when the food
has no ingredient text, and for sensitivity-tier allergens on every food (`description`, shown with the
label "food-category estimate"). An exclude phrase hides its words from that allergen only ("cocoa butter"
is not milk). `Food.allergensMatchedAt` is set after the rows are written; a food without it (cached before
T11, or a failed write) is matched again on its next read. A dictionary edit reaches already matched foods
only through the re-match pass (T5).

Log routes (design doc A2, R3-25 to R3-27; T6): `logentries` (`LogEntry {userId, date, meal, fdcId, grams,
source, confidence, photoBatchId, createdAt}`, indexes `{userId, date}` and `{date}`) and `userallergens`
(`UserAllergen {userId, allergenId, mode, weeklyThreshold}`, unique per member and allergen). Listing,
creating and allergen settings live under `/api/users/me/*`, so no route names another member; `PUT/DELETE
/api/logs/:id` pass `requireOwner`, which answers 404 `log_not_found` for an id that names no entry and 403
`forbidden` for another account's entry, whatever roles the caller holds. `date` is the member's calendar
day in their `MemberProfile.timezone` (UTC when unset). An entry's date and food are fixed once logged; a
wrong food is deleted and logged again. Hard alerts compare the food's `allergens[]` (T11) with the
member's avoid-mode settings; the exposure meter and daily totals come later with the summary service.

Deletion and re-match (design doc D6, R3-3, R3-4; T5): no Mongo transactions, every step rerunnable.
Account deletion (`services/account.ts`, shared by `DELETE /api/users/me` and the Admin delete of T21) sets
`User.deletionPending` first, so login and every session of the account answer `403
account_deletion_pending` from then on; then it deletes the account's `LogEntry`, `UserAllergen`, the three
role profiles and its `sessions` documents, then the `User`, then the logs and settings once more (a write
that passed `requireAuth` before the flag). The route retries a failed cascade once; if that fails too the
account stays locked, and the member's next login with the right password finishes the deletion before
answering 403. The only usable Admin (active, not being deleted) gets `409 last_admin`, checked before and
after the flag with `usableAdminCount` (the same count as role changes); a refusal clears the flag, so a
flagged last Admin's next login calls the deletion off and signs them in. `DELETE /api/allergens/:id`
deletes the allergen's `FoodAllergen` and `UserAllergen` rows, then the entry, then its `FoodAllergen` rows
once more (a food matched meanwhile); a retry after the entry is gone still sweeps its rows before answering
404, and a re-match that finds its allergen gone drops the rows it wrote. After a dictionary edit,
`startRematch` sets `Allergen.rematchCursor` to 0 (the next fdcId to process) and bumps `rematchRun`;
`rematchAllergen` walks the cached foods in fdcId batches of 500, one ordered `bulkWrite` per batch (delete
the allergen's rows in the batch's range, insert the new matches), and moves the cursor only if neither the
cursor nor the run changed meanwhile. It stops after 60 seconds with `{done: false, processed, remaining}`
and resumes from the cursor; null means done. The routes that call it (Curator POST/PUT and
`/api/curate/allergens/:id/rematch`) come with T21.

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
src/middleware/       requireOwner (log entries: 404 unknown, 403 another account's), error handler (always JSON, never a stack), notFound, secretsGuard (503 secret_unconfigured),
                      requireAuth (401/403, loads the account), requireRole(role) (403 forbidden)
src/models/           Mongoose models: User, MemberProfile, CuratorProfile, AdminProfile, LoginAttempt, SearchCache, Food,
                      Allergen, FoodAllergen, DictionarySeed, LogEntry, UserAllergen
src/services/auth.ts  register (user + member profile, rerunnable), login (constant-cost), me, setActiveRole
src/services/throttle.ts  login throttle: reserveAttempt (one atomic upsert before the compare), clearFailures
src/services/usda.ts  USDA FoodData Central proxy: searchFoods (SearchCache), getFood (Food cache-on-read), normalization
src/services/dictionary.ts  allergen dictionary: seed on read (DictionarySeed marker), matchFood (normalizer + matcher), matchAndStore, allergensForFood,
                      startRematch/rematchAllergen (cursor batches), deleteAllergen (row cascade)
src/services/account.ts  deleteAccount: the rerunnable account deletion cascade (deletionPending first)
src/services/logs.ts  day logs (todayIn, listLogs, createLog with fetch-and-match and alerts, updateLog) and allergen settings
src/services/roles.ts setRoles (admin route: atomic conditional role write, lockout guards), usableAdminCount (shared with self-delete), applyAdminBootstrap (ADMIN_USERNAMES)
src/routes/           one router per resource (health, spike, auth, users, admin, foods, allergens, logs); routers never touch fetch or process.env
test/setup.ts         mongodb-memory-server per worker, collections cleared after each test
test/fixtures/usda/   recorded USDA payloads (search, a Foundation food, a branded food) for the food tests
```
