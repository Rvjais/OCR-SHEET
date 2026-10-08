#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root=${TEXTLENS_ROOT:-/opt/textlens}
image_ref=${1:?Usage: deploy.sh ghcr.io/owner/image:commit-sha}
release=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [[ ! $image_ref =~ ^ghcr\.io/[a-z0-9._/-]+:[a-f0-9]{40}$ ]]; then
  echo 'Expected a GHCR image tagged with a full commit SHA.' >&2
  exit 1
fi
if [[ $release != "$root"/releases/* || ! -f $root/.env ]]; then
  echo 'Put releases under /opt/textlens/releases and configure /opt/textlens/.env first.' >&2
  exit 1
fi
if [[ -e $root/current && ! -L $root/current ]]; then
  echo 'The current release path must be a symlink, not a directory.' >&2
  exit 1
fi

exec 9>"$root/.deploy.lock"
flock -x 9
registry_username=${2:-}
if [[ -n $registry_username ]]; then
  registry_dir=$(mktemp -d "$root/.registry.XXXXXX")
  export DOCKER_CONFIG=$registry_dir
  trap 'rm -f "$registry_dir/config.json"; rmdir "$registry_dir" || true' EXIT
  # The short-lived GitHub Actions token arrives over SSH stdin, never argv.
  docker login ghcr.io -u "$registry_username" --password-stdin
fi
previous=''
if [[ -L $root/current ]]; then
  previous=$(readlink -f "$root/current")
  if [[ $previous != "$root"/releases/* || ! -f $previous/.image ]]; then
    echo 'The previous release is invalid; refusing to replace it.' >&2
    exit 1
  fi
fi

compose() {
  docker compose --project-name textlens --env-file "$root/.env" -f "$release/compose.yml" "$@"
}

rollback() {
  echo 'Deployment failed. Restoring the previous release.' >&2
  if [[ -n $previous ]]; then
    release=$previous
    export TEXTLENS_IMAGE
    TEXTLENS_IMAGE=$(cat "$previous/.image")
    compose up -d --wait --wait-timeout 300 || echo 'Rollback also failed; inspect docker compose logs.' >&2
  else
    compose down || true
    echo 'No previous release exists. Fix the error and rerun the workflow.' >&2
  fi
}

export TEXTLENS_IMAGE=$image_ref
compose config --quiet
# Pull before stopping the current containers. Failed pulls leave them running.
compose pull
if ! compose up -d --wait --wait-timeout 300; then
  rollback
  exit 1
fi

domain=$(compose exec -T api printenv BACKEND_DOMAIN)
if [[ ! $domain =~ ^[a-zA-Z0-9.-]+$ ]]; then
  rollback
  exit 1
fi
if ! curl --fail --silent --show-error --retry 8 --retry-all-errors \
  --retry-delay 5 --max-time 10 "https://$domain/api/health" > "$release/.health.json"; then
  rollback
  exit 1
fi
if ! compose exec -T api python -c \
  'import json,sys; d=json.load(sys.stdin); assert d["status"]=="ok"; assert d["service"]=="textlens-handwriting"; assert d["version"]==sys.argv[1]; assert d["available"] and d["loaded"]; assert not d["requires_access_token"]' \
  "${image_ref##*:}" < "$release/.health.json"; then
  rollback
  exit 1
fi

printf '%s\n' "$image_ref" > "$release/.image"
ln -sfn "$release" "$root/current"
echo "Deployment verified: https://$domain/api/health"
