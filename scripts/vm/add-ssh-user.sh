#!/usr/bin/env bash
# Owner-side: give one more person SSH access to the shared dev VM as their own Linux user,
# using project-level metadata SSH keys (no OS Login). Appends to the existing ssh-keys value
# instead of replacing it.
# Usage: scripts/vm/add-ssh-user.sh <username> <path-to-public-key>
#    or: scripts/vm/add-ssh-user.sh <username> ssh-ed25519 AAAA... comment
# The person then connects with: gcloud compute ssh <username>@instance-20260914-165802 --zone us-central1-a
# (they need roles/compute.instanceAdmin.v1 or just the project's compute.instances.get + IAP/SSH
# network access; the simplest grant for a teammate is roles/compute.viewer plus this key).
set -euo pipefail
user="${1:?username}"; shift
[ $# -ge 1 ] || { echo "usage: $0 <username> <public-key-file | inline public key>" >&2; exit 1; }
P="${HEALTHEAT_GCP_PROJECT:-study-488509}"
# Accept either a path to a .pub file or the key pasted inline (all remaining arguments).
if [ -f "$1" ]; then key="$(tr -d '\n' < "$1")"; else key="$*"; fi
case "$key" in ssh-*|ecdsa-*) ;; *) echo "not an OpenSSH public key: $keyfile" >&2; exit 1;; esac
tmp="$(mktemp)"
gcloud compute project-info describe --project "$P" --format='value(commonInstanceMetadata.items.filter(key:ssh-keys).extract(value).flatten())' > "$tmp" || true
grep -v "^$user:" "$tmp" | grep -v '^$' > "$tmp.new" || true
printf '%s:%s %s\n' "$user" "$key" "$user" >> "$tmp.new"
gcloud compute project-info add-metadata --project "$P" --metadata-from-file ssh-keys="$tmp.new" >/dev/null
rm -f "$tmp" "$tmp.new"
echo "added ssh key for $user to project metadata; sudo is granted automatically to metadata-key users (google-sudoers)."
