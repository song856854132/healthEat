#!/usr/bin/env bash
# Run AFTER `vercel build --cwd apps/<app>` and BEFORE `vercel deploy --prebuilt --cwd apps/<app>`.
#
# Why: this repo is an npm-workspaces monorepo with one Vercel project per app and the CLI run
# inside the app directory. Vercel's builders then record two kinds of entries in each function's
# .vc-config.json "filePathMap" that the prebuilt upload resolves relative to apps/<app>:
#   1. hoisted dependencies that actually live in the repo-root node_modules
#      (e.g. node_modules/next/dist/...): copy each missing file from the root into apps/<app>;
#   2. the workspace package @healtheat/shared, which at the root is a symlink the upload refuses
#      and which the function cannot resolve at runtime: copy its built files into the function
#      output as real files and drop the map entry.
# Usage: scripts/fix-vercel-output.sh api|web
# NOTE: step 1 leaves partial package copies in apps/<app>/node_modules. That is fine on a CI
# runner, but on a dev machine run `npm run clean:vercel` afterwards or local builds break
# (Turbopack resolves the partial copy of next first).
set -euo pipefail
app="${1:?app name (api|web)}"
root="$(cd "$(dirname "$0")/.." && pwd)"
appdir="$root/apps/$app"
out="$appdir/.vercel/output/functions"
[ -d "$out" ] || { echo "no functions output for apps/$app; nothing to fix"; exit 0; }
export ROOT="$root" APPDIR="$appdir"
funcs=0; copied=0; shared=0
while IFS= read -r func; do
  cfg="$func/.vc-config.json"; [ -f "$cfg" ] || continue
  funcs=$((funcs+1))
  # 1. materialise hoisted sources under apps/<app>
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    [ -e "$appdir/$key" ] && continue
    if [ -e "$root/$key" ]; then
      mkdir -p "$(dirname "$appdir/$key")"
      cp -RL "$root/$key" "$appdir/$key"
      copied=$((copied+1))
    fi
  done < <(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])).get("filePathMap") or {}; print("\n".join(k for k in m if "@healtheat/shared" not in k))' "$cfg")
  # 2. workspace package into the function output
  if grep -q '@healtheat/shared' "$cfg"; then
    dst="$func/node_modules/@healtheat/shared"
    rm -rf "$dst"; mkdir -p "$dst"
    cp -R "$root/packages/shared/package.json" "$root/packages/shared/dist" "$dst/"
    [ -e "$func/node_modules/zod" ] || cp -RL "$root/node_modules/zod" "$func/node_modules/zod"
    python3 - "$cfg" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); m=d.get("filePathMap") or {}
for k in [k for k in m if "@healtheat/shared" in k or "@healtheat/shared" in str(m[k])]: m.pop(k)
if m: d["filePathMap"]=m
else: d.pop("filePathMap",None)
json.dump(d,open(p,"w"),indent=2)
PY
    shared=$((shared+1))
  fi
done < <(find "$out" -maxdepth 1 -name '*.func' -type d)
echo "apps/$app: $funcs function(s); $copied hoisted file(s) materialised; shared fixed in $shared"
