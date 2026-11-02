#!/usr/bin/env bash
# Nightly Postgres backup for the OxBlood stack.
#
# Dumps the `divide` database from the running postgres container into a
# gzip file outside the repo, verifies it, and prunes old copies.
#
#   BACKUP_DIR      where dumps go            (default /DATA/Backups/oxblood)
#   KEEP_DAYS       how long to keep them     (default 14)
#   PG_CONTAINER    postgres container name   (default divide-postgres)
#   PG_USER / PG_DB                           (default divide / divide)
#
# Restore:  gunzip -c <file> | docker exec -i divide-postgres psql -U divide -d divide
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/DATA/Backups/oxblood}"
KEEP_DAYS="${KEEP_DAYS:-14}"
PG_CONTAINER="${PG_CONTAINER:-divide-postgres}"
PG_USER="${PG_USER:-divide}"
PG_DB="${PG_DB:-divide}"

log() { printf '%s backup_db: %s\n' "$(date -u +%FT%TZ)" "$*"; }

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$BACKUP_DIR/${PG_DB}_${stamp}.sql.gz"
tmp="$final.partial"
trap 'rm -f "$tmp"' EXIT

docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null \
  || { log "postgres is not ready; aborting"; exit 1; }

log "dumping $PG_DB from $PG_CONTAINER"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" --no-owner | gzip -9 > "$tmp"

# A dump is only a backup if it is complete: valid gzip, not tiny, and pg_dump
# wrote its end marker (a killed pg_dump leaves a truncated but valid-looking file).
gzip -t "$tmp"
[ "$(stat -c %s "$tmp")" -gt 1024 ] || { log "dump is suspiciously small; aborting"; exit 1; }
gunzip -c "$tmp" | tail -n 5 | grep -q "PostgreSQL database dump complete" \
  || { log "dump has no completion marker; aborting"; exit 1; }

mv "$tmp" "$final"
chmod 600 "$final"
log "wrote $final ($(du -h "$final" | cut -f1))"

find "$BACKUP_DIR" -maxdepth 1 -name "${PG_DB}_*.sql.gz" -type f -mtime "+$KEEP_DAYS" -print -delete \
  | sed 's/^/pruned /' || true
log "done; $(find "$BACKUP_DIR" -maxdepth 1 -name "${PG_DB}_*.sql.gz" | wc -l) backup(s) kept"
