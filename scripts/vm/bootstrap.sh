#!/usr/bin/env bash
# healthEat shared dev VM: machine-level provisioning. Idempotent; run with sudo on the VM:
#   sudo bash scripts/vm/bootstrap.sh
# Installs Node 22 (Ubuntu's own package), npm, gh, tmux, unzip, Playwright's system deps,
# relaxes the AppArmor user-namespace restriction (headless Chromium / gstack browser), and
# drops a profile snippet with the project's non-secret defaults. Per-user setup is in
# scripts/vm/user-setup.sh.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends \
  ca-certificates curl git gnupg unzip tmux jq build-essential python3 \
  nodejs npm

# GitHub CLI from GitHub's apt repo (Ubuntu's own package lags).
if ! command -v gh >/dev/null 2>&1 || [ "$(gh --version | head -1 | awk '{print $3}' | cut -d. -f1)" -lt 2 ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -q && apt-get install -y -q gh
fi

# Playwright / Chromium system libraries. `install-deps` may not recognise a brand-new Ubuntu
# release; fall back to the usual library set.
if ! npx --yes playwright@latest install-deps chromium >/dev/null 2>&1; then
  apt-get install -y -q --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 \
    libcairo2 fonts-liberation || true
fi

# Headless Chromium (gstack /browse, Playwright) needs unprivileged user namespaces.
cat > /etc/sysctl.d/60-healtheat-userns.conf <<'SYSCTL'
kernel.apparmor_restrict_unprivileged_userns = 0
SYSCTL
sysctl -q --system >/dev/null

# Non-secret defaults for every login shell.
cat > /etc/profile.d/healtheat.sh <<'PROFILE'
# healthEat shared dev VM defaults (non-secret). Secrets are loaded per user by
# scripts/vm/user-setup.sh into ~/.env.staging.
export HEALTHEAT_GCP_PROJECT=study-488509
export CLOUDSDK_CORE_PROJECT=study-488509
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$PATH"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
PROFILE

echo
echo "bootstrap done:"
echo "  node $(node -v), npm $(npm -v), gh $(gh --version | head -1 | awk '{print $3}'), tmux $(tmux -V | awk '{print $2}')"
echo "  userns restriction: $(sysctl -n kernel.apparmor_restrict_unprivileged_userns)"
echo "next: each person runs  bash scripts/vm/user-setup.sh  as themselves."
