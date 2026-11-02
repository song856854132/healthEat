# Changelog

## 0.1.1 (2026-11-02)

- Release fix: the web production build no longer receives an empty `API_ORIGIN` from CI (the `v0.1.0` tag deployed the API but failed on the web with "Invalid rewrite found"); the release workflow passes the production API domain explicitly.

## 0.1.0 (2026-11-02, API only; web build failed)

- Monorepo scaffold: `apps/web` (Next.js 16), `apps/api` (Express 5), `packages/shared` (zod schemas). Plan task T2.
- Proxy spike: `/api/*` rewrite from the web origin to the Express service, cookie and 65 s acceptance tests, verified on Vercel previews 2026-11-02. Plan task T1.
- CI/CD: `ci` (checks), `preview` (per-PR Vercel deploys + Playwright), `staging` (fixed alias of `main`), `release` (production on `v*` tags), `claude` (PR review).
- Shared GCP dev VM scripts: `scripts/vm/bootstrap.sh`, `scripts/vm/user-setup.sh`.
