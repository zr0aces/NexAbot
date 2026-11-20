# Compose deployment

Use a supported Linux Docker Engine and Compose. Reserve space for database, Redis AOF, pending originals and disposable thumbnails. Restrict Docker access to trusted administrators. Keep the deployment environment and separately backed-up encryption key outside version control.

The `web` service in `docker-compose.yml` selects the unprivileged Nginx image and declares its published ports. Dockerfile.web builds the React assets into that image; this runs one Nginx container, not a separate static server and proxy. No override file is required. Start without the edge profile:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 -f api worker
```

Only the web service is published: loopback and the host LAN address (192.168.8.70) on port 8068. Both bindings use `WEB_PORT` from `.env` (default: `8068`). For example, set `WEB_PORT=9068`, run `docker compose up -d --no-deps web`, and change the proxy upstream to port 9068. Check the published ports with `docker compose ps web`. The container still listens on 8080; APP_URL, the LINE webhook and the Google callback do not change. The examples below use the default host port. Reserve that address in DHCP or update the LAN binding in docker-compose.yml if it changes. PostgreSQL and Redis have no published ports. Bundled Caddy is optional for a standalone installation; do not enable its edge profile alongside the existing reverse proxy.

**Existing Nginx/Caddy:** point DNS for the hostname in `APP_URL` to your proxy, terminate TLS there, and forward the entire HTTPS origin to **192.168.8.70:8068** from a LAN proxy or **127.0.0.1:8068** from the same host. Sign in through the canonical HTTPS origin; the direct HTTP listener is for the proxy, not for submitting credentials. Preserve Host and the raw webhook bytes. The API does not trust client-supplied forwarded addresses. Disable query-string logging for OAuth callback routes on every proxy. Keep credentials in the server environment. For Nginx on another LAN host, use `proxy_pass http://192.168.8.70:8068;` and `proxy_set_header Host $host;`. In a proxy container, loopback refers to that container, not the Docker host. See [connectivity checks](TROUBLESHOOTING.md#check-the-network-path).

## Operations

```sh
# Stop without removing volumes
docker compose stop

# Manual migration (API also migrates before listening)
docker compose run --rm api node node_modules/prisma/build/index.js migrate deploy

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
