# TODOS

## healthEat

### Week rewriter (meal plan that regenerates on a gap)

**What:** A weekly meal plan (`Plan` model) that regenerates remaining days when today's log opens a nutrient gap or trips a sensitivity threshold.

**Why:** The most "alive" feature from office hours; cut from the 2026 fall plan at eng-review decision D3 to protect phases 0 to 3.

**Context:** Needs the 7-day coverage service and the "close the gap" ranking from phase 1 as inputs, plus a planning step that fills slots from cached Foods or a recipe source. Design it as its own /office-hours pass before building; the original sketch is in `docs/designs/healtheat-nutrient-coach.md` (Approaches and Next Steps, Phase 4).

**Effort:** L
**Priority:** P4
**Depends on:** Phases 1 and 2 shipped

### CI: cache the mongodb-memory-server binary

**What:** Add an `actions/cache@v4` step in `ci.yml` for `~/.cache/mongodb-binaries` so API tests stop downloading ~100 MB per run.

**Why:** Deferred from plan: `~/.claude/plans/resume-the-unfinished-implementation-federated-otter.md` (T9a). The step's `key:` line tripped the pregate secret scan; the key value must start with a `${{ ... }}` expression (env.kv exempts expression-leading values).

**Context:** `.github/workflows/ci.yml` comment names this item. Verify with `gstack-pregate` on the branch before relying on it.

**Effort:** S
**Priority:** P1
**Depends on:** nothing

### Atlas: separate database user for production

**What:** Create a second Atlas database user scoped `readWrite@healtheat_prod` and set the production `MONGODB_URI` in Vercel to it; keep the current user for preview, staging and dev databases.

**Why:** Review finding (T9a adversarial): one cluster and one user across preview, staging and production means a preview deployment of an unreviewed branch can read and write `healtheat_prod`.

**Context:** Atlas console (Database Access), then `vercel env add MONGODB_URI production --cwd apps/api` with the new URI. No code change.

**Effort:** S
**Priority:** P1
**Depends on:** nothing

### Food routes: abuse limit and cache footprint

**What:** Cap what anonymous callers of `/api/foods/*` can spend: a global hourly budget for uncached USDA calls (a Mongo counter shared by every instance) and smaller cache entries (store only the fields a result row renders), plus a bound or prune for `Food` documents no log entry references.

**Why:** Deferred from plan: `docs/designs/healtheat-nutrient-coach.md` (T3), owner decision dec-c0d8580f on 2026-11-14. A script that varies the search text can spend the USDA key's 3,600-an-hour quota and grow `searchcaches` and `foods` on the shared 512 MB M0 cluster, which also holds production.

**Context:** A per-IP limit is unreliable here: behind the Next.js rewrite `req.ip` may be one shared Vercel hop (see the Login throttle note in `apps/api/README.md`). The code marker is in `apps/api/src/app.ts` (`gstack-shortcut(dec-c0d8580f-...)`).

**Effort:** M
**Priority:** P1
**Depends on:** nothing

### Unmatched queue: retire tokens a later dictionary edit makes matchable

**What:** When a Curator edit (not a queue "map") adds a synonym that now matches a pending unmatched-ingredient token, mark the token mapped or hide it from the queue.

**Why:** Otherwise those tokens stay pending in `/curate/unmatched` with stale counts (eng review 2026-11-18, outside voice OV6).

**Context:** T22 records tokens in `matchAndStore`; the allergen re-match (`rematchAllergen`) has its own path. A check per dictionary edit over pending tokens, or a filter at queue read time, would do.

**Effort:** S
**Priority:** P3
**Depends on:** T22

### Photo logging: set the Anthropic key, then tighten refusals and spend

**What:** (1) The owner sets `ANTHROPIC_API_KEY` in Vercel (Preview and Production, API project) and in `~/.env.staging` on the dev VM; until then `POST /api/vision/meal` answers `503 vision_unavailable`. (2) Then, before members rely on it: tell a refusal that comes back with text apart from an unparseable answer (call `messages.create`, check `stop_reason` before parsing) so a declined photo says "log the meal by search" instead of "try again"; refund unbilled upstream failures (bad key, 5xx, overload) without spending the daily refund allowance; lower `max_tokens` toward the cost model; decide on an app-wide daily photo ceiling.

**Why:** Deferred from plan: `~/.claude/plans/resume-the-unfinished-implementation-federated-otter.md` (Step 8, T13 owner step). The follow-ups are the non-blocking notes of the T13 review; spend is already capped at 30 calls per member per day.

**Context:** `apps/api/src/services/vision.ts`, `apps/api/src/services/visionUsage.ts`; T18 (vision eval) recorded its baseline through workload identity federation, so it does not need the key.

**Effort:** S
**Priority:** P1
**Depends on:** the owner's key

## Completed
