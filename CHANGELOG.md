# Changelog

## 0.1.0 (unreleased)

- Monorepo scaffold: `apps/web` (Next.js 16), `apps/api` (Express 5), `packages/shared` (zod schemas). Plan task T2.
- Proxy spike: `/api/*` rewrite from the web origin to the Express service, cookie and 65 s acceptance tests, verified on Vercel previews 2026-11-02. Plan task T1.
- CI/CD: `ci` (checks), `preview` (per-PR Vercel deploys + Playwright), `staging` (fixed alias of `main`), `release` (production on `v*` tags), `claude` (PR review).
- Shared GCP dev VM scripts: `scripts/vm/bootstrap.sh`, `scripts/vm/user-setup.sh`.
