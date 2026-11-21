#!/usr/bin/env bash
set -euo pipefail
pg=$(docker run -d --rm -e TZ=Asia/Bangkok -e POSTGRES_PASSWORD=fixture -e POSTGRES_DB=gallery -p 127.0.0.1::5432 postgres:18)
redis=""
trap 'docker stop "$pg" ${redis:+"$redis"} >/dev/null' EXIT
redis=$(docker run -d --rm -p 127.0.0.1::6379 redis:7-alpine)
export DATABASE_URL="postgresql://postgres:fixture@$(docker port "$pg" 5432)/gallery" REDIS_URL="redis://$(docker port "$redis" 6379)" GALLERY_INTEGRATION=1
for i in {1..50}; do docker exec "$pg" pg_isready -h 127.0.0.1 -U postgres >/dev/null && break; sleep 1; done
export APP_URL=https://fixture.invalid GOOGLE_REDIRECT_URI=https://fixture.invalid/callback
export SESSION_SECRET=fixture-session-secret-not-for-production BOOTSTRAP_SECRET=fixture-bootstrap-not-for-production
export TOKEN_ENCRYPTION_KEY=$(printf '%064d' 0)
go run ./cmd/rivosnap migrate
go test -p 1 -count=1 -v ./...
