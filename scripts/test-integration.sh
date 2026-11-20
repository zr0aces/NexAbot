#!/usr/bin/env bash
set -euo pipefail
for tool in ffmpeg ffprobe; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }; done
pg=$(docker run -d --rm -e POSTGRES_PASSWORD=fixture -e POSTGRES_DB=gallery -p 127.0.0.1::5432 postgres:18)
redis=""
trap 'docker stop "$pg" ${redis:+"$redis"} >/dev/null' EXIT
redis=$(docker run -d --rm -p 127.0.0.1::6379 redis:7-alpine)
export DATABASE_URL="postgresql://postgres:fixture@$(docker port "$pg" 5432)/gallery" REDIS_URL="redis://$(docker port "$redis" 6379)" GALLERY_INTEGRATION=1
for i in {1..50}; do docker exec "$pg" pg_isready -h 127.0.0.1 -U postgres >/dev/null && break; sleep 1; done
corepack pnpm migrate
corepack pnpm test
# Compare a Go-first install to the canonical Prisma-first schema and exercise
# both upgrade directions, including Prisma deployment on the Go-created ledger.
docker exec "$pg" createdb -U postgres go_fresh
prisma_url=$DATABASE_URL
export DATABASE_URL="${prisma_url%/*}/go_fresh"
export APP_URL=https://fixture.invalid GOOGLE_REDIRECT_URI=https://fixture.invalid/callback
export SESSION_SECRET=fixture-session-secret-not-for-production BOOTSTRAP_SECRET=fixture-bootstrap-not-for-production
export TOKEN_ENCRYPTION_KEY=$(printf '%064d' 0)
go run ./cmd/rivosnap migrate
corepack pnpm migrate
schema() { docker exec "$pg" pg_dump -U postgres --schema-only --restrict-key=fixture "$1"; }
# Dump commands must themselves succeed, not just produce equal output.
expected=$(schema gallery)
actual=$(schema go_fresh)
diff -u <(printf '%s\n' "$expected") <(printf '%s\n' "$actual")
DATABASE_URL="$prisma_url" go run ./cmd/rivosnap migrate
go test -count=1 -v ./...
