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

## Completed
