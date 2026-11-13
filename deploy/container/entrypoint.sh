#!/bin/sh
set -eu
# File settings are exclusive with environment values; never print secret values.
load_secret() {
  name="$1"
  eval "value=\${$name-}"
  eval "file=\${${name}_FILE-}"
  if [ -n "$file" ]; then
    [ -z "$value" ] || { echo "$name and ${name}_FILE are mutually exclusive" >&2; exit 1; }
    [ -r "$file" ] || { echo "${name}_FILE is unreadable" >&2; exit 1; }
    value=$(cat "$file")
    [ -n "$value" ] || { echo "${name}_FILE is empty" >&2; exit 1; }
    export "$name=$value"
  fi
}
for name in DATABASE_URL BETTER_AUTH_SECRET ENCRYPTION_KEY; do load_secret "$name"; done
case "${DATABASE_URL-}" in
  postgres://*|postgresql://*) ;;
  *) echo 'Container deployments require a PostgreSQL DATABASE_URL' >&2; exit 1 ;;
esac
cd /app
case "${1:-serve}" in
  serve)
    node commands/admin.mjs validate
    node commands/admin.mjs migrate
    exec node .output/server/index.mjs ;;
  migrate|bootstrap|operator) exec node commands/admin.mjs "$@" ;;
  *) echo 'Usage: serve | migrate | bootstrap email@example.com | operator email@example.com' >&2; exit 1 ;;
esac
