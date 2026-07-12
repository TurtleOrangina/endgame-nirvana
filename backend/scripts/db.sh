#!/bin/sh
#
# Applies migrations, generates frontend TypeScript types, and seeds puzzles
# against the running self-hosted Supabase stack. Requires the Supabase CLI
# (https://supabase.com/docs/guides/cli) and a running stack (`sh run.sh start`).
#
# Usage:
#   sh scripts/db.sh push                        # apply pending migrations
#   sh scripts/db.sh types                        # generate frontend/src/types/database.ts
#   sh scripts/db.sh seed [--only-add] [path-to-exercises.json] # seed public.puzzles from exercises.json
#                                                  # (path defaults to ../frontend/public/exercises.json;
#                                                  #  default prunes puzzles missing from the file,
#                                                  #  --only-add keeps them; to seed production instead,
#                                                  #  run `node scripts/seed_puzzles.mjs --prod` directly)
#   sh scripts/db.sh all [path-to-exercises.json]  # push + types + seed
#
# If the connection pooler rejects the CLI, connect directly instead:
#   docker exec -i supabase-db psql -U postgres -d postgres < supabase/migrations/<file>.sql

set -e

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
    echo "ERROR: .env not found in $(pwd)" >&2
    exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

DB_URL="postgresql://postgres.${POOLER_TENANT_ID}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}?sslmode=disable"

push() {
    PGSSLMODE=disable supabase db push --db-url "$DB_URL"
}

types() {
    supabase gen types typescript --db-url "$DB_URL" --schema public > ../frontend/src/types/database.ts
    echo "Wrote ../frontend/src/types/database.ts"
}

seed() {
    node scripts/seed_puzzles.mjs "$@"
}

case "$1" in
    push) push ;;
    types) types ;;
    seed) shift; seed "$@" ;;
    all)
        push
        types
        shift
        seed "$@"
        ;;
    *)
        echo "Usage: sh scripts/db.sh push|types|seed|all [--only-add] [path-to-exercises.json]" >&2
        exit 1
        ;;
esac
