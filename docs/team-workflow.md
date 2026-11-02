# healthEat team workflow: agents, GitHub CI/CD, GCP dev VM, Vercel staging and production

Written 2026-11-02 for a two-person team (owner + one teammate). Companion to
`docs/designs/healtheat-nutrient-coach.md` (the plan) and `TODOS.md`.
Decision 2026-11-02: staging runs on Vercel as a fixed alias of `main`; GCP hosts only
the shared dev VM. Cloud Run was considered and deferred (see section 9).
Status: agreed; set up on 2026-11-02 (URLs in README.md).

## 0. Two facts that shape everything

1. **Claude Code is per person; the API key is per app.** Both people have Claude Max
   subscriptions, so each logs Claude Code in with their own account (on the VM too; the
   login is a URL-and-code flow that works over SSH). Subscription logins are never shared.
   The one shared Anthropic credential is the **app's API key** used server-side for photo
   recognition (`ANTHROPIC_API_KEY` on the API), created in an Anthropic Console workspace
   `healtheat-app` with a **USD 30 monthly spend limit**. It lives in Vercel env and GCP
   Secret Manager, never in the repo or a prompt. CI's PR review runs on the owner's
   subscription through a `claude setup-token` token (section 4).
2. **Vercel Hobby (free) has no team members.** A commit authored by a GitHub account
   that is not the Vercel project owner is refused by the Git integration
   ("the git author must have access to the project"). The fix is to **deploy from
   GitHub Actions with the Vercel CLI and the owner's `VERCEL_TOKEN`**, and switch the
   Git integration off. Then the teammate never needs a Vercel login, previews work
   for every PR regardless of author, and production deploys become an explicit CI
   step instead of "whatever landed on main".

Both facts push the same direction: **GitHub is the control plane**. Humans and agents
only ever push branches and open PRs; CI does every deploy with secrets nobody types.

## 1. Environments

| Tier       | Where                                                                                                                    | Trigger                                   | Data                                                                                                    | Purpose                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Dev        | Shared GCP VM (one Linux user each) or your laptop                                                                       | you                                       | `mongodb-memory-server` for tests; Atlas staging cluster, db `healtheat_dev_<username>` for manual runs | Claude Code + gstack sessions in tmux; identical toolchain for both people                                                       |
| PR preview | Vercel preview deploys (api, then web), created by CI                                                                    | every PR push                             | Atlas **staging** cluster, db `healtheat_preview`                                                       | Review a change on the real production platform; Playwright e2e runs here                                                        |
| Staging    | Vercel non-production deploy of `main`, aliased to `healtheat-staging.vercel.app` and `healtheat-api-staging.vercel.app` | merge to `main`                           | Atlas **staging** cluster, db `healtheat_staging`                                                       | Long-lived integration environment with seeded users for all three roles; demo rehearsal; the URL the teammate opens after merge |
| Production | Vercel production deploy (same two projects)                                                                             | git tag `v*` pushed by `/ship` or by hand | Atlas **production** cluster                                                                            | The graded URL                                                                                                                   |

Because every tier above Dev is Vercel, the two Vercel-specific risks in the plan
(T1 proxy spike: `Set-Cookie` through the Next.js rewrite; the 300 s `maxDuration` on the
API function) are exercised on every PR preview and on staging, not only in production.

Wiring: the web project's **preview** environment has `API_ORIGIN=https://healtheat-api-staging.vercel.app`
permanently, so staging web always talks to staging API. PR previews override it per
deploy with that PR's API preview URL (section 4). The **production** environment has
`API_ORIGIN` set to the production API domain.

Atlas: the free M0 tier allows one cluster per Atlas **project**, so make two projects
(`healtheat-prod`, `healtheat-staging`). Preview, staging and manual dev share the
staging cluster with different database names.

## 2. Accounts and access (one-time, owner does this)

| System                      | Owner                                                                                          | Teammate                                                                                                                                                          | Agents (CI)                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Claude Code                 | own Max login                                                                                  | own Max login                                                                                                                                                     | `CLAUDE_CODE_OAUTH_TOKEN` GitHub secret from the owner's `claude setup-token` (PR review)                              |
| Anthropic Console           | owner; workspace `healtheat-app`, one API key, USD 30/month cap                                | none                                                                                                                                                              | none (the key is a runtime secret of the API, not a CI secret)                                                         |
| GitHub repo                 | admin                                                                                          | write (collaborator)                                                                                                                                              | `GITHUB_TOKEN` (default)                                                                                               |
| GCP project `study-488509`  | owner                                                                                          | `roles/compute.viewer` plus their SSH public key in project metadata (own Linux user with sudo), `roles/secretmanager.secretAccessor` on the four staging secrets | none (CI does not touch GCP)                                                                                           |
| Vercel                      | account owner                                                                                  | none needed                                                                                                                                                       | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID_WEB`, `VERCEL_PROJECT_ID_API` as GitHub secrets                    |
| Atlas                       | org owner                                                                                      | project member on `healtheat-staging` only (read access with `mongosh`)                                                                                           | connection strings as Vercel env vars (preview and production environments) and GitHub secrets for the preview deploys |
| USDA key, app Anthropic key | owner registers; values in Secret Manager (`usda-api-key`, `anthropic-api-key`) and Vercel env | reads via `~/.env.staging` on the VM                                                                                                                              | Vercel env vars                                                                                                        |

Rule: **no production secret is ever on a laptop or the VM.** Production values live in
Vercel's production environment only. Staging values live in GCP Secret Manager (read by
the VM at login) and in Vercel's preview environment.

## 3. Branch, PR and release flow

- `main` is protected: PR required, CI green required, one approving review required,
  linear history, no force push. Nobody commits to `main` directly, agents included.
- One branch per task from the plan: `t07-admin-bootstrap`, `t21-curator-admin-surfaces`.
  Create the 22 tasks (T1 to T22 in the design doc) as GitHub Issues with labels
  `lane:a` (api + shared), `lane:b` (web), `lane:c` (tooling), `phase:0..3`.
  Suggested split: owner takes lane A, teammate takes lane B, lane C goes to whoever
  finishes first. The plan's rule stands: `packages/shared` schema shapes are frozen
  after T2 and change only through lane A.
- Day-to-day with agents:
  1. `git worktree add ../healthEat-t21 -b t21-curator-admin-surfaces` (or `/using-git-worktrees`).
  2. Claude Code in tmux on the VM; `/verify` before pushing.
  3. `/ship` opens the PR (it merges `main`, runs tests, reviews the diff, writes the PR body).
  4. CI runs section 4; the two preview URLs are posted as a PR comment.
  5. Review: the **other human** approves (required). The Claude GitHub Action
     (`anthropics/claude-code-action`) also reviews every PR automatically and answers
     `@claude` comments; its findings are advice, the human approval is the gate.
  6. Squash-merge. CI redeploys staging from `main` and re-points the aliases.
  7. Open `healtheat-staging.vercel.app`, log in as the seeded role you touched, check the feature in context.
- Release to production: `git tag v0.3.0 && git push --tags` (or let `/ship` bump
  VERSION and tag). The `release` workflow deploys both projects with `--prod`.
  Before tagging, run the staging checklist: anonymous Home, login as the three seeded
  roles, one text log, one photo log, one dictionary edit with re-match, one admin
  suspend. Rollback is `vercel rollback` or re-tagging the previous commit.

## 4. GitHub Actions (five workflows)

```
.github/workflows/
  ci.yml        on: pull_request, push to main
                jobs: typecheck+lint -> unit (vitest) -> api (supertest, mongodb-memory-server)
  preview.yml   on: pull_request
                jobs: vercel deploy api (env MONGODB_URI=<staging>/healtheat_preview, ...)
                      -> vercel deploy web --env API_ORIGIN=<api preview url>
                      -> wait for both -> playwright e2e against the web preview URL
                      -> comment both URLs on the PR
  staging.yml   on: push to main
                jobs: vercel deploy api -> vercel alias set <url> healtheat-api-staging.vercel.app
                      -> vercel deploy web -> vercel alias set <url> healtheat-staging.vercel.app
                      -> smoke: GET /api/health and GET / return 200 on the aliases
                      -> seed script (idempotent): three role accounts, dictionary, sample logs
  release.yml   on: push tags v*
                jobs: vercel deploy --prod api -> vercel deploy --prod web
                      -> smoke on production URLs -> GitHub Release notes from CHANGELOG
  claude.yml    on: pull_request, issue_comment (@claude)
                uses: anthropics/claude-code-action@v1 with claude_code_oauth_token (owner's Max, via `claude setup-token`)
```

Notes:

- Every Vercel CLI call runs with `--cwd apps/<app>`; each app is its own project with root
  directory `.`, and CI uploads prebuilt output, so no Vercel root-directory setting is needed.
  After `vercel build`, `scripts/fix-vercel-output.sh <app>` copies the built `packages/shared`
  into each function's output and drops the builder's broken `filePathMap` entry for the
  npm-workspace symlink (otherwise the prebuilt upload or the function at runtime fails).
- Deployment Protection (Vercel Authentication) must be **Disabled** on both projects
  (Project → Settings → Deployment Protection); it is on by default and would block Playwright
  and the web-to-API rewrite with a 302 to a login page. Previews are then public URLs with
  random names; nothing sensitive runs on them.
- Deploy the API before the web in every workflow because the web rewrite needs
  `API_ORIGIN`. For previews, pass that PR's API URL with `--env`; for staging and
  production the environment variable is fixed in the Vercel project.
- Set `"git": { "deploymentEnabled": false }` in both `vercel.json` files so Vercel's
  own Git integration never deploys; CI is the only deployer. This replaces plan
  decision D8's "preview branch alias" with aliases CI controls explicitly.
- Playwright on PRs (plan T14/T17) runs against the preview URL, not localhost, so the
  proxy cookie path is exercised on every PR.
- Hobby limits worth knowing: 100 deployments per day across the account, and
  `vercel.app` aliases are free. Two deploys per PR push plus two per merge stays far
  below that for two people.
- Cost: GitHub Actions free minutes are enough if e2e is PR-only. The Claude review
  action runs on the owner's Max subscription (no API spend).

## 5. The shared GCP VM (the "agent workbench")

Why a shared VM at all, given each person could run Claude Code locally with their own
key: identical toolchain, sessions that survive a closed laptop (tmux), one place to
install gstack, Node and Playwright browsers once, and no staging secret on a personal
machine. Local remains allowed for anyone who prefers it. This is the only GCP resource.

- Machine: Compute Engine `e2-standard-4` (4 vCPU, 16 GB) is comfortable for Next.js
  builds plus Playwright; `e2-standard-2` works if builds are patient. Attach a
  schedule that stops it nightly (`gcloud compute resource-policies create
instance-schedule`) so an idle box costs nothing after midnight.
- Access: metadata SSH keys, one Linux user per person (`song856854132` for the owner; the
  teammate's key is appended with `scripts/vm/add-ssh-user.sh <user> <key.pub>`). OS Login was
  tried and reverted on 2026-11-02 because it creates extra generated usernames. Connect with
  `gcloud compute ssh <user>@instance-20260914-165802 --zone us-central1-a`.
- Per-user setup (each person, once): `gh auth login` (commits are attributed to the
  real author), `git config user.name/email`, Claude Code, `~/.claude/skills/gstack`
  via the repo's CLAUDE.md instructions.
- Claude Code: each person runs `claude` once and logs in with their own Max account
  (URL + paste code). No API key is involved. Staging secrets (`SESSION_SECRET`,
  `MONGODB_URI`, `USDA_API_KEY`, the app's `ANTHROPIC_API_KEY`) are read with the person's
  own `gcloud auth login` identity by `scripts/vm/user-setup.sh` into `~/.env.staging`
  (mode 600, git-ignored). The VM's service account deliberately has no Secret Manager scope.
- Known host limitation (recorded for the owner's Ubuntu box; fixed on the VM by bootstrap.sh): the
  gstack bundled Chromium needs unprivileged user namespaces; on a fresh Ubuntu 24.04
  VM run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (persist in
  `/etc/sysctl.d/`) so `/browse`, `/qa` and Playwright headless all work.
- Mongo for manual dev: point `MONGODB_URI` at the staging cluster, database
  `healtheat_dev_<username>`, so two people never collide and tests still use
  `mongodb-memory-server`.

## 6. Debugging staging without Vercel access

Vercel Hobby cannot grant the teammate log access, so staging logs are owner-only.
Three mitigations, cheapest first:

1. Reproduce on the VM: run both apps locally against `healtheat_staging` (read-only
   mindset; use `healtheat_dev_<username>` for anything that writes).
2. The API writes every caught 5xx to an `ErrorLog` collection (`{at, route, status,
  message, requestId}`, TTL 14 days) that either person can read with `mongosh`. Add this
   to T9 (reliability baseline) as a one-line extension of the error middleware.
3. If that is not enough, add a free log integration (for example Axiom) from the Vercel
   integrations page; integrations are allowed on Hobby.

## 7. Agent conventions both people follow

- The plan is the spec. `docs/designs/healtheat-nutrient-coach.md` and `TODOS.md` are
  the source of truth; a decision that changes them gets a dated note in the doc
  (as D18 did) and a `gstack-decision-log` entry. Agents are told to read the plan
  section for the task before coding.
- `CLAUDE.md` in the repo grows a short "how we work here" block: run `/verify` before
  push, `/ship` for PRs, never commit secrets, never deploy from a laptop, one task per
  PR, keep `packages/shared` changes in lane A.
- Every PR body states which task (T-number) it closes and which phase gate it moves.
- Spend: Claude Code usage is covered by each person's Max plan. The app's API key has a
  USD 30 monthly cap in the Console; if photo recognition hits it, the API returns a clear
  error and text logging keeps working. Check the Console usage page weekly.
- Nothing in a prompt or a commit that you would not paste into a public issue: no
  connection strings, no keys, no real user data from the member accounts.

## 8. Checklists

Owner, before inviting:

1. Anthropic Console: workspace `healtheat-app` with a USD 30/month limit and one API key; value into Vercel env and Secret Manager `anthropic-api-key`. Run `claude setup-token` once and store the result as GitHub secret `CLAUDE_CODE_OAUTH_TOKEN`.
2. GitHub: protect `main`; add secrets (`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID_WEB`, `VERCEL_PROJECT_ID_API`, `CLAUDE_CODE_OAUTH_TOKEN`); install the Claude GitHub App.
3. GCP: project, the VM with metadata SSH keys and a stop schedule, Secret Manager secrets (staging env, app keys), IAM roles from section 2. Done 2026-11-02.
4. Vercel: two projects created once by hand with Git deployments disabled; preview and production env vars set; confirm `vercel alias set` works on the two staging names.
5. Atlas: two projects, two M0 clusters, IP access list open (0.0.0.0/0 is the pragmatic choice on M0; auth is the real gate).
6. Land T1 (proxy spike) and T2 (scaffold) yourself first so the teammate joins a repo that builds, deploys a preview, and has CI green.

Teammate, first day:

1. On the VM, run `claude` and log in with your own Max account (URL + code flow).
2. Accept the GitHub collaborator invite; `gh auth login` on the VM.
3. `gcloud auth login`, `gcloud compute ssh healtheat-dev`; confirm `$ANTHROPIC_API_KEY` is set.
4. Read the plan's Recommended Approach and Implementation Tasks, this file, and `TODOS.md`.
5. Pick the first lane-B task (after T1 and T2 land), create the worktree, run `/verify`,
   open a PR with `/ship`, confirm the preview URLs appear on the PR, and after merge open the staging URL.

## 9. Deferred: Cloud Run staging

Considered and deferred on 2026-11-02. It would add Dockerfiles for both apps, Artifact
Registry, Workload Identity Federation for CI, and a `staging.yml` that deploys two Cloud
Run services on merge to `main`. Benefits: the teammate could hold GCP log viewer roles,
and the Express API would visibly run as its own server. Costs: a second platform to
understand, and it does not exercise the Vercel-specific risks (rewrite cookie
passthrough, 300 s function limit). Revisit only if the instructor rejects Express
behind the proxy (the plan's Approach B fallback), in which case the API moves off
Vercel anyway. CI stays the only deployer either way, so the teammate's workflow does
not change if that happens.

## Open items

- Whether the instructor wants the staging URL or only production.
