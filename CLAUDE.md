## gstack (recommended)

This project uses [gstack](https://github.com/garrytan/gstack) for AI-assisted workflows.
Install it for the best experience:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team
```

Skills like /qa, /ship, /review, /investigate, and /browse become available after install.
Use /browse for all web browsing (Aside first, the bundled gstack browser as fallback). Use ~/.claude/skills/gstack/... for gstack file paths.

## How we work here

- The plan is the spec: `docs/designs/healtheat-nutrient-coach.md` (Recommended Approach,
  Working plan amendments, Implementation Tasks T1-T22) and `TODOS.md`. Read the task's
  section before coding. Team process: `docs/team-workflow.md`.
- One plan task per PR; the PR body names the T-number. Branch `tNN-short-name`, worktree per task.
- Before pushing run `/verify` (or `npm run typecheck && npm run lint && npm run format && npm test`).
  Open PRs with `/ship`. CI deploys previews, staging and production; never deploy from a laptop.
- Never commit secrets or connection strings. Staging env lives in `~/.env.staging` on the VM.
- `packages/shared` schema shapes change only through lane A (API owner). Roles are Member,
  Curator, Admin; there is no human coach role (D18).
- PR body = `.github/PULL_REQUEST_TEMPLATE.md` (T-number, `Closes #issue`, what, how verified).
  Feature PRs do not bump VERSION or CHANGELOG (decline it if `/ship` offers); the owner cuts
  releases from `main` with a `v*` tag. Never push tags from a branch.
- `scripts/fix-vercel-output.sh` is a CI step; never run it on a dev machine (`npm run clean:vercel` if you did).
- Task order and dependencies: design doc, "Implementation Tasks: order and dependencies".
