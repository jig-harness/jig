#!/usr/bin/env bash
# check-schema-drift.sh — ephemeral-replay drift check (skeleton).
#
# The strongest drift check for a schema-like artifact: instead of comparing
# file timestamps or re-running a generator, replay the SOURCE OF TRUTH
# (ordered SQL migrations) from absolute scratch in a throwaway container,
# dump the resulting schema, normalize both sides identically, and diff
# against the committed artifact. This validates the whole chain — the
# migrations really produce the schema the repo claims they do.
#
# This is ONE INSTANTIATION (docker + Postgres + pg_dump) of a general
# pattern; see README.md for the pattern and its portability notes.
#
# Requires: docker, a migrations directory of ordered *.sql files, and a
# committed schema dump to compare against. Well-commented skeleton — adapt
# the normalization to your engine before relying on it.
#
# Usage:
#   ./check-schema-drift.sh <migrations-dir> <committed-schema.sql>
#
# Exit codes: 0 = no drift; 1 = drift; 2 = environment/setup failure.
set -euo pipefail

MIGRATIONS_DIR="${1:?usage: check-schema-drift.sh <migrations-dir> <committed-schema.sql>}"
COMMITTED_SCHEMA="${2:?usage: check-schema-drift.sh <migrations-dir> <committed-schema.sql>}"

# Pin the image. In real use, pin to an immutable digest
# (<image>@sha256:<digest>) so upstream tag movement cannot silently change
# dump output — pg_dump formatting varies across Postgres versions, and a
# moved tag turns into phantom "drift".
PG_IMAGE="${PG_IMAGE:-postgres:18}"
PG_USER=postgres
PG_DB=postgres
PG_PASSWORD=postgres
READY_TIMEOUT_SECS=60

# Name the container deterministically PER WORKING DIRECTORY (hash of $PWD),
# so parallel checkouts/worktrees of the same repo on one machine never
# fight over a shared container name.
CONTAINER="ephemeral-replay-$(pwd | cksum | cut -d' ' -f1)"

[ -d "$MIGRATIONS_DIR" ] || { echo "error: no such directory: $MIGRATIONS_DIR" >&2; exit 2; }
[ -f "$COMMITTED_SCHEMA" ] || {
  echo "error: committed schema not found: $COMMITTED_SCHEMA" >&2
  echo "Run your schema generator first, and commit its output." >&2
  exit 2
}

docker version >/dev/null 2>&1 || {
  echo "error: docker is not available or the daemon is not running." >&2
  exit 2
}

cleanup() {
  # Debug escape hatch: KEEP_CONTAINER=1 leaves the container in place so a
  # failed run can be inspected (docker logs / docker exec ... psql).
  if [ -n "${KEEP_CONTAINER:-}" ]; then
    echo "KEEP_CONTAINER set — leaving $CONTAINER running for inspection." >&2
    return
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Remove a leftover container from a crashed previous run (scoped to our own
# naming convention — the only "destructive" cleanup this script does).
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# Start detached. Deliberately NOT --rm: if initialization fails, --rm would
# delete the container before its logs could be read, leaving nothing to
# debug. cleanup() removes it explicitly instead.
docker run --detach --name "$CONTAINER" \
  --env POSTGRES_PASSWORD="$PG_PASSWORD" \
  --env POSTGRES_USER="$PG_USER" \
  --env POSTGRES_DB="$PG_DB" \
  "$PG_IMAGE" >/dev/null

# ── Readiness: two gates, in order ──────────────────────────────────────────
# Gate 1: the official postgres entrypoint starts a TEMPORARY server during
# initdb, shuts it down, then starts the permanent one. pg_isready reports
# success during the temporary phase, so polling it alone is a race — a
# caller can connect just as the temporary server is torn down. Wait for the
# entrypoint's init-complete log line before trusting pg_isready.
SENTINEL='PostgreSQL init process complete; ready for start up.'
deadline=$(( $(date +%s) + READY_TIMEOUT_SECS ))
until docker logs "$CONTAINER" 2>&1 | grep -qF "$SENTINEL"; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "error: Postgres init did not complete within ${READY_TIMEOUT_SECS}s" >&2
    docker logs --tail 40 "$CONTAINER" >&2 || true
    exit 2
  fi
  sleep 0.5
done

# Gate 2: poll pg_isready against the permanent server.
until docker exec "$CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "error: Postgres did not become ready within ${READY_TIMEOUT_SECS}s" >&2
    exit 2
  fi
  sleep 0.5
done

# ── Replay the source of truth from scratch ─────────────────────────────────
# Apply every migration in filename order. LC_ALL=C pins the order across
# machines. Stream each file over docker exec stdin — no host psql client
# needed, and nothing is copied into the container.
echo "Replaying migrations from $MIGRATIONS_DIR ..." >&2
find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | LC_ALL=C sort | while IFS= read -r f; do
  echo "  applying $(basename "$f")" >&2
  docker exec -i --env PGPASSWORD="$PG_PASSWORD" "$CONTAINER" \
    psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -X -q < "$f"
done

# ── Dump ────────────────────────────────────────────────────────────────────
# The dump flags already remove one class of volatility: ownership,
# privileges, and tablespaces differ per environment and say nothing about
# the schema itself. Add --schema=<name> flags if you use more than public.
FRESH=$(mktemp)
COMMITTED_NORM=$(mktemp)
trap 'rm -f "$FRESH" "$COMMITTED_NORM"; cleanup' EXIT INT TERM
docker exec --env PGPASSWORD="$PG_PASSWORD" "$CONTAINER" \
  pg_dump -U "$PG_USER" -d "$PG_DB" \
    --schema-only --no-owner --no-privileges --no-tablespaces \
    --no-security-labels \
  > "$FRESH.raw"

# ── Normalize BOTH sides identically ────────────────────────────────────────
# The committed file and the fresh dump must go through the SAME pipeline.
# Normalizing only the fresh side is a proven trap: any later fix to the
# normalizer makes every previously committed artifact look "drifted" until
# it is manually regenerated. Symmetric normalization removes that entire
# false-positive class.
normalize() {
  sed -e '/^--/d'          `# comment lines (version banners, timestamps)` \
      -e '/^SET /d'        `# session SET statements vary across versions` \
      -e '/^SELECT pg_catalog.set_config/d' \
      -e 's/[[:space:]]*$//'  `# trailing whitespace` \
    | awk 'NF || p; {p=NF}'    # collapse runs of blank lines
}
normalize < "$FRESH.raw" > "$FRESH"
normalize < "$COMMITTED_SCHEMA" > "$COMMITTED_NORM"
rm -f "$FRESH.raw"

# ── Compare ─────────────────────────────────────────────────────────────────
if diff -u "$COMMITTED_NORM" "$FRESH"; then
  echo "OK: committed schema matches a clean replay of $MIGRATIONS_DIR."
else
  echo '' >&2
  echo "DRIFT: $COMMITTED_SCHEMA is out of sync with what the migrations" >&2
  echo "produce from scratch. The committed artifact is stale (or was" >&2
  echo "hand-edited)." >&2
  echo '' >&2
  echo "To fix: rerun your schema generator against these migrations and" >&2
  echo "commit the regenerated $COMMITTED_SCHEMA." >&2
  exit 1
fi
