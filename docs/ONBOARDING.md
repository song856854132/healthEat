# Onboarding (teammate, day one)

You need: a GitHub account (collaborator invite accepted), a Google account the owner has
granted on GCP project `study-488509`, and your own Claude Max subscription. You do not need
a Vercel account, an Anthropic API key, or any production secret.

## 1. Reach the VM

```bash
gcloud auth login
gcloud config set project study-488509
gcloud compute ssh instance-20260914-165802 --zone us-central1-a
```

OS Login turns your Google account into a Linux user (for a Gmail account the name looks like
`yourname_gmail_com`). If the VM is stopped (it stops nightly at 02:00 Asia/Taipei):

```bash
gcloud compute instances start instance-20260914-165802 --zone us-central1-a
```

## 2. Set yourself up on the VM (once, about 10 minutes)

```bash
git clone https://github.com/song856854132/healthEat.git ~/healthEat   # gh will re-auth this below
bash ~/healthEat/scripts/vm/user-setup.sh
```

The script installs Claude Code and gstack for your user, signs you into GitHub and gcloud
(browser code flows; open the URLs on your own computer), clones the repo, installs
dependencies and the Playwright browser, and writes `~/.env.staging` from Secret Manager.
Then run `claude` once and complete the login with your Max account.

## 3. Work on a task

```bash
tmux new -s t21                                  # sessions survive a closed laptop
cd ~/healthEat && git pull --ff-only
git worktree add ../healthEat-t21 -b t21-curator-admin-surfaces
cd ../healthEat-t21 && claude
```

Inside Claude Code: read the task in the design doc (Implementation Tasks, your T-number),
build, run `/verify`, then `/ship` to open the PR. CI posts two preview URLs on the PR and runs
Playwright against them. The other person approves; squash-merge; open
https://healtheat-staging.vercel.app to see it on staging.

Rules in one breath: one task per PR, PR body names the T-number, never commit secrets,
never deploy from a laptop (CI deploys), `packages/shared` changes go through lane A.

## Owner side (for reference)

Grants the owner makes for a new teammate, with their Google email `TEAMMATE`:

```bash
P=study-488509
gcloud projects add-iam-policy-binding $P --member=user:TEAMMATE --role=roles/compute.osAdminLogin
gcloud projects add-iam-policy-binding $P --member=user:TEAMMATE --role=roles/iam.serviceAccountUser
for s in session-secret-staging mongodb-uri-staging usda-api-key anthropic-api-key; do
  gcloud secrets add-iam-policy-binding $s --project $P --member=user:TEAMMATE --role=roles/secretmanager.secretAccessor
done
gh api -X PUT repos/song856854132/healthEat/collaborators/TEAMMATE_GITHUB -f permission=push
```

`osLogin` instead of `osAdminLogin` gives SSH without sudo.
