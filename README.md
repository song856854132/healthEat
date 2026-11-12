# healthEat

A weekly nutrient-and-sensitivity coach. Calorie trackers stop at calories; healthEat tells you
when your week is running low on a nutrient, which real foods close the gap, and tracks your
exposure to the ingredients your body reacts to. Kambaz open-ended final project, graduate tier.

- Design and plan: [`docs/designs/healtheat-nutrient-coach.md`](docs/designs/healtheat-nutrient-coach.md) (approved; tasks T1 to T22 at the end)
- How the team works: [`docs/team-workflow.md`](docs/team-workflow.md)
- New teammate: [`docs/ONBOARDING.md`](docs/ONBOARDING.md)
- Backlog beyond the plan: [`TODOS.md`](TODOS.md)
- API environment variables, health endpoints and JSON error codes: [`apps/api/README.md`](apps/api/README.md)

## Layout

```
apps/web          Next.js 16 (App Router). Proxies /api/* to the API so cookies stay same-origin.
apps/api          Express 5 REST API (Vercel zero-config Express; src/app.ts exports the app).
packages/shared   zod schemas and TypeScript types shared by both.
e2e/              Playwright acceptance tests, run against Vercel preview URLs in CI.
scripts/vm/       Shared GCP dev VM provisioning (bootstrap.sh) and per-user setup (user-setup.sh).
scripts/e2e/      local-stack.mjs: in-memory MongoDB, api on 4100, web on 3100; Playwright starts it when BASE_URL is unset.
.github/workflows ci, preview, staging, release, claude (+ reusable _vercel-deploy).
```

## Run locally

In a fresh clone or a new `git worktree`, start with the first two lines; both are needed before any check.

```bash
npm ci
npm run build:shared
set -a; . .env.example; set +a   # or on the VM: set -a; . ~/.env.staging; set +a  (the API reads plain env vars, no dotenv)
npm run dev:api                 # http://localhost:4000/api/health
npm run dev:web                 # http://localhost:3000  (API_ORIGIN=http://localhost:4000)
npm test                        # unit + API tests (vitest, supertest); API tests start an in-memory MongoDB (first run downloads a ~100 MB binary)
npm run e2e                     # Playwright; without BASE_URL it starts a local stack (in-memory MongoDB, api, web) itself
```

## Environments

| Tier       | URL                                                                                  | Deployed by                                                                                  |
| ---------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| PR preview | commented on each PR (web + api)                                                     | `preview` workflow on every PR push                                                          |
| Staging    | https://healtheat-staging.vercel.app (api: https://healtheat-api-staging.vercel.app) | `staging` workflow on merge to `main`                                                        |
| Production | https://healtheat-web.vercel.app (api: https://healtheat-api.vercel.app)             | `release` workflow on a `v*` tag pushed from `main` by the owner (first: v0.1.1, 2026-11-02) |

Vercel's Git integration is disabled on purpose (`vercel.json`), so GitHub Actions is the only
deployer and a teammate needs no Vercel account. Deployment Protection is disabled on both
Vercel projects so previews are reachable by Playwright and by the web app's `/api/*` rewrite. The shared dev VM is GCP project
`study-488509`, instance `instance-20260914-165802` (us-central1-a), static IP 34.57.33.133, one Linux user per person via
metadata SSH keys, stopped nightly at 01:00 New York time; start it with
`gcloud compute instances start instance-20260914-165802 --zone us-central1-a`.

Demo accounts: the admin account is listed in the API project's `ADMIN_USERNAMES` on preview (which
staging uses) and production. A listed username cannot be registered (`409 username_reserved`), so on
each database the owner first registers the account as an ordinary member, then adds it to the list;
it becomes admin at its next login. After a database reset: remove it from the list, register it,
list it again. Other roles are granted from that account through
`PUT /api/admin/users/:username/roles` (`apps/api/README.md`).

## Pipeline status

The first pull request on this repo exercised `ci`, `preview` (Vercel previews + Playwright through the
proxy) and, after merge, `staging` and `release`. Dates and results live in `CHANGELOG.md`.

## Release

```bash
# on main, after the staging checklist in docs/team-workflow.md passes
git tag v0.2.0 && git push --tags
```
