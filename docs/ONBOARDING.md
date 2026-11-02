# Onboarding (teammate, day one)

You need: a GitHub account (collaborator invite accepted), a Google account the owner has
granted viewer access on GCP project `study-488509`, an SSH key the owner has added to the VM,
and your own Claude Max subscription. You do not need a Vercel account, an Anthropic API key,
or any production secret.

## 1. Reach the VM

Send the owner your public key (`~/.ssh/id_ed25519.pub`; create one with `ssh-keygen -t ed25519`
if you have none) and the Linux username you want. Then:

```bash
gcloud auth login
gcloud config set project study-488509
gcloud compute ssh <your-username>@instance-20260914-165802 --zone us-central1-a \
  --ssh-key-file ~/.ssh/id_ed25519
```

`--ssh-key-file` must point at the private key matching the public key you sent; without it
gcloud generates a new key and tries to register it, which your viewer role cannot do. Plain
OpenSSH also works (`ssh -i ~/.ssh/id_ed25519 <your-username>@<external IP>`), but the external
IP changes whenever the VM restarts until a static address is reserved. You get your own
Linux user with sudo. If the VM is stopped (it stops nightly at 01:00 New York time):

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

Grants the owner makes for a new teammate, with their Google email `TEAMMATE`, GitHub login
`TEAMMATE_GITHUB`, chosen Linux username `tm` and public key file `tm.pub`:

```bash
P=study-488509
gcloud projects add-iam-policy-binding $P --member=user:TEAMMATE --role=roles/compute.viewer
scripts/vm/add-ssh-user.sh tm tm.pub          # or: add-ssh-user.sh tm ssh-ed25519 AAAA... comment
for s in session-secret-staging mongodb-uri-staging usda-api-key anthropic-api-key; do
  gcloud secrets add-iam-policy-binding $s --project $P --member=user:TEAMMATE --role=roles/secretmanager.secretAccessor
done
gh api -X PUT repos/song856854132/healthEat/collaborators/TEAMMATE_GITHUB -f permission=push
```

The VM uses metadata SSH keys, not OS Login, so the only Linux users are `song856854132`
(owner) and one per teammate. Removing a teammate = deleting their line from the project
`ssh-keys` metadata and their home directory.
