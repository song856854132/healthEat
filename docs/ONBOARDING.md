# Onboarding (teammate, day one)

Current teammate: GitHub `ydo22`, Linux user `shankul`. Everything below is written for that
person and that person's coding agent; the same steps apply to anyone added later.

## 0. What you need before you start

| You need                                                                                                                                                                                                          | Who provides it                                                       | How to check                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub collaborator access (write)                                                                                                                                                                                | owner (done for `ydo22`)                                              | https://github.com/song856854132/healthEat shows a "Code" button with a push-able clone, `gh repo view song856854132/healthEat`                                             |
| Google account granted on GCP project `study-488509`: `roles/compute.viewer`, the custom role `healtheatVmOperator` (start and stop the VM), and `roles/secretmanager.secretAccessor` on the four staging secrets | owner, in the Cloud Console or with the commands in the owner section | `gcloud compute instances list --project study-488509` works; `gcloud secrets versions access latest --secret=session-secret-staging --project study-488509` prints a value |
| Your SSH public key added to the VM                                                                                                                                                                               | owner, `scripts/vm/add-ssh-user.sh` (done for `shankul`)              | `ssh shankul@34.57.33.133` logs in                                                                                                                                          |
| Your own Claude Max subscription                                                                                                                                                                                  | you                                                                   | you can log in at claude.ai                                                                                                                                                 |
| gcloud CLI on your laptop                                                                                                                                                                                         | you: https://cloud.google.com/sdk/docs/install                        | `gcloud --version`                                                                                                                                                          |

You do not need a Vercel account, an Anthropic API key, or any production secret.

## 1. Reach the VM

The VM stops every night at 01:00 New York time to save money. Start it if needed, then
connect. Both commands run on your laptop:

```bash
gcloud auth login                      # shankul890@gmail.com
gcloud config set project study-488509
gcloud compute instances start instance-20260914-165802 --zone us-central1-a   # only if stopped
ssh -i ~/.ssh/id_ed25519 shankul@34.57.33.133
```

The address is static (`healtheat-dev-ip`). Put it in `~/.ssh/config` once and use `ssh healtheat`:

```
Host healtheat
  HostName 34.57.33.133
  User shankul
  IdentityFile ~/.ssh/id_ed25519
```

`gcloud compute ssh shankul@instance-20260914-165802 --zone us-central1-a --ssh-key-file ~/.ssh/id_ed25519`
also works; the `--ssh-key-file` flag is required because gcloud would otherwise try to
register a new key, which your role cannot do.

## 2. Set yourself up on the VM (once, about 10 minutes)

The repo is public, so the first clone needs no credentials:

```bash
git clone https://github.com/song856854132/healthEat.git ~/healthEat
bash ~/healthEat/scripts/vm/user-setup.sh
```

The script, for your Linux user only: installs bun, Claude Code and gstack; runs
`gh auth login` (device code: open the URL on your laptop) and `gcloud auth login
--no-launch-browser` (same idea); sets `git user.name` / `user.email` if unset; runs `npm ci`,
builds `packages/shared`, installs the Playwright browser; and writes `~/.env.staging` from
Secret Manager (`SESSION_SECRET`, `MONGODB_URI`, `USDA_API_KEY`, `ANTHROPIC_API_KEY`,
`API_ORIGIN`, `PORT`) plus `MONGODB_DB=healtheat_dev_<your Linux user>`, your own database on the
shared cluster. Lines that say "no access" mean the owner has not granted that secret yet.

Then log Claude Code in with your own account (URL + paste code):

```bash
claude
```

Set your git identity explicitly if you prefer (the email must be verified on your GitHub
account, or use your GitHub noreply address):

```bash
git config --global user.name "Shankul"
git config --global user.email "shankul890@gmail.com"
```

## 3. Work on a task

Tasks are GitHub Issues `T3` to `T22`, each labelled `lane:a` (API and `packages/shared`,
owner), `lane:b` (web, you) or `lane:c` (tooling). Dependencies and a suggested order are in
the design doc under "Implementation Tasks: order and dependencies". Your first task is the
web-only part of **T12**: the privacy banner with its acknowledgment cookie, `/privacy`,
`/about`, the footer and the nav shell. It needs no API.

Every task follows the same loop (worktree per task, tmux so the session survives a closed laptop):

```bash
tmux new -s t12
cd ~/healthEat && git pull --ff-only
git worktree add ../healthEat-t12 -b t12-privacy-banner
cd ../healthEat-t12
npm ci && npm run build:shared          # a fresh worktree has no node_modules and no shared dist
set -a; . ~/.env.staging; set +a        # staging env for manual runs (not needed for tests)
claude
```

Inside Claude Code:

1. Read the task's entry in the design doc (Implementation Tasks) and the matching GitHub issue.
2. Build. Run `/verify` before pushing (same as `npm run typecheck && npm run lint && npm run format && npm test`).
   For a manual check run `npm run dev:api` and `npm run dev:web` in two tmux panes, then open
   http://localhost:3000. `npm run e2e` needs neither: without `BASE_URL` it starts its own stack
   (in-memory MongoDB, api on 4100, web on 3100 so a running dev stack is never reused; `scripts/e2e/local-stack.mjs`) and stops it afterwards.
3. `/ship` opens the PR. If `/ship` proposes a VERSION or CHANGELOG bump, decline it: feature
   PRs do not bump versions; the owner cuts releases.
4. The PR body follows `.github/PULL_REQUEST_TEMPLATE.md`: the T-number, `Closes #<issue>`,
   what changed, how you verified. CI posts two preview URLs on the PR and runs Playwright
   against them. A `claude` review comment may appear; it is advice, not the gate.
5. The owner approves and squash-merges. Within a few minutes `main` is on
   https://healtheat-staging.vercel.app; check your change there.

Never: commit secrets or connection strings; push to `main` directly; push `v*` tags (owner
only, from `main`); change `packages/shared` schema shapes in a lane-B PR (ask the owner);
run `scripts/fix-vercel-output.sh` on the VM (it is a CI step and breaks local builds; if you
did, `npm run clean:vercel`).

## Owner side (for reference)

Grants the owner makes for a new teammate, with Google email `TEAMMATE`, GitHub login
`TEAMMATE_GITHUB`, chosen Linux username `tm` and public key `tm.pub` (or the key pasted inline):

```bash
P=study-488509
gcloud projects add-iam-policy-binding $P --member=user:TEAMMATE --role=roles/compute.viewer
gcloud projects add-iam-policy-binding $P --member=user:TEAMMATE --role=projects/$P/roles/healtheatVmOperator
for s in session-secret-staging mongodb-uri-staging usda-api-key anthropic-api-key; do
  gcloud secrets add-iam-policy-binding $s --project $P --member=user:TEAMMATE --role=roles/secretmanager.secretAccessor
done
scripts/vm/add-ssh-user.sh tm tm.pub       # or: scripts/vm/add-ssh-user.sh tm ssh-ed25519 AAAA... comment
gh api -X PUT repos/song856854132/healthEat/collaborators/TEAMMATE_GITHUB -f permission=push
```

`healtheatVmOperator` is a project custom role with `compute.instances.get/list/start/stop`
and `compute.zoneOperations.get`, so a teammate can start the VM after the nightly stop
without being able to delete or reconfigure it.

The VM uses metadata SSH keys, not OS Login, so the only Linux users are `song856854132`
(owner) and one per teammate. Removing a teammate = deleting their line from the project
`ssh-keys` metadata, their home directory, their IAM bindings and the GitHub collaboration.
