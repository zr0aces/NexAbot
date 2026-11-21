# Compose deployment

**Upgrading an existing installation?** Before running Compose, set `COMPOSE_PROJECT_NAME` in the deployment environment to the existing project name (shown by `docker compose ls`). The new default is `rivosnap`; changing the project name selects different volumes and can start an empty database. Keep the original environment and volumes.

Publishing a GitHub Release tagged `v<root VERSION>` triggers the release workflow. It builds Linux/amd64 images for the API (with embedded React assets) and worker services and pushes them to `ghcr.io/<owner>/rivosnap-{api,worker}:<VERSION>` and `:latest`. The `web` service runs the upstream `nginxinc/nginx-unprivileged:stable-alpine` image directly with no custom build. Draft releases and tag pushes alone do not publish images.

To run published GHCR images on another server without a local build, see the [image deployment example](example-deploy/README.md).

Use a supported Linux Docker Engine and Compose. Reserve space for database, Redis AOF, pending originals and disposable thumbnails. Restrict Docker access to trusted administrators. Keep the deployment environment and separately backed-up encryption key outside version control.

The `web` service in `docker-compose.yml` uses the stock `nginxinc/nginx-unprivileged:stable-alpine` image, mounts `infra/docker/web.conf`, and proxies all traffic to `api:3000` (which serves both `/api/*` and the embedded React SPA). No custom `web` image build or override file is required. Start without the edge profile:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 -f api worker
```

Only the web service is published on `WEB_PORT` from `.env` (default: `8080`, bound to port only: `"${WEB_PORT:-8080}:8080"`). For example, set `WEB_PORT=8068` in `.env`, run `docker compose up -d --no-deps web`, and point your proxy upstream to port 8068. Check the published ports with `docker compose ps web`. The container still listens on 8080; APP_URL, the LINE webhook and the Google callback do not change. PostgreSQL and Redis have no published ports. Bundled Caddy is optional for a standalone installation; do not enable its edge profile alongside the existing reverse proxy.

**Existing Nginx/Caddy:** point DNS for the hostname in `APP_URL` to your proxy, terminate TLS there, and forward the entire HTTPS origin to **<host-ip>:${WEB_PORT:-8080}** from a LAN proxy or **127.0.0.1:${WEB_PORT:-8080}** from the same host. Sign in through the canonical HTTPS origin; the direct HTTP listener is for the proxy, not for submitting credentials. Preserve Host and the raw webhook bytes. The bundled web proxy takes the client address from `X-Forwarded-For` only when the connection comes from a private or loopback address, and passes the result to the API as `X-Real-IP`; the API honours `X-Real-IP` only from a private or loopback peer. An external Nginx must send `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (Caddy sends it by default). Without it, every visitor shares the proxy host's rate-limit bucket: no worse than before, but not fixed. Disable query-string logging for OAuth callback routes on every proxy. Keep credentials in the server environment. For Nginx on another LAN host, use `proxy_pass http://<host-ip>:8080;` (or your configured `WEB_PORT`) and `proxy_set_header Host $host;`. In a proxy container, loopback refers to that container, not the Docker host. See [connectivity checks](TROUBLESHOOTING.md#check-the-network-path).

A fresh Go installation applies the same checked-in SQL and records the same migration history as Prisma. An unfinished or mismatched migration stops startup; investigate it on a restored copy rather than deleting migration records or volumes. An untracked pre-release schema requires a verified manual baseline before cutover.

## Operations

```sh
# Stop without removing volumes
docker compose stop

# Manual migration (API also migrates before listening)
docker compose run --rm api /app/rivosnap migrate

# Update after taking a backup and checking release compatibility
docker compose stop worker
docker compose pull postgres redis
docker compose build --pull
docker compose up -d
docker compose ps
```

Do not use down -v, erase cache mounts while uploads are active, or scale workers independently during migrations. Defaults use /data/staging and /data/thumbnails; if changing these paths also change mounts, ownership and server environment together. Containers run without root. Check the dashboard for cache usage, free space, retention warnings, oldest pending image and worker heartbeat.

## Metadata backup and restore

```sh
umask 077
docker compose exec -T postgres pg_dump -U gallery -d gallery -Fc > gallery.dump
# Inspect and restore into a NEW, empty recovery database, never overwrite production
docker compose exec -T postgres pg_restore --list < gallery.dump
docker compose exec -T postgres createdb -U gallery gallery_recovery
docker compose exec -T postgres pg_restore -U gallery -d gallery_recovery --exit-on-error < gallery.dump
```

A database backup contains **metadata, passwords hashes, encrypted credentials, outbox and audit state, not original image backups**. Keep its separate application encryption key secure. Redis is transport, not the recovery authority. Thumbnails are never backups.

For a coordinated recovery point stop API and worker before the dump and retain existing staging volumes. Do not point a live worker at a restored database until the operator has reconciled every remote write since the snapshot, especially album mappings and nonterminal images. Restoring older state alone can cause duplicates or lose track of newer Google media. Test restoration on an isolated host, then update DATABASE_URL to the verified database and restart; retain the former database for rollback. For application-only rollback use the prior image tags with the compatible expanded schema.
