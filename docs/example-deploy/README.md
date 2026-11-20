# Deploy NexAbot from GHCR

Copy **this entire directory** from the desired release to a fresh Linux host, for example as `/opt/nexabot`. It includes a standalone `compose.yml` with release-pinned image tags and an `env.example`. No other repository files, source checkout, or build tools are needed. The host needs Docker Engine, Compose v2, and an existing HTTPS reverse proxy.

1. Confirm the publisher provides the three GHCR package names in `compose.yml` for your host architecture, using the tags shown in that file. Change the example package paths if necessary. For private packages, sign in to `ghcr.io` with a read-only package credential using `docker login --password-stdin`.
2. From the copied directory, run `install -m 600 env.example .env` **once**, before adding secrets. Set the lowercase `GHCR_OWNER`, public HTTPS `APP_URL` (no trailing slash), and the host’s `LAN_IP`. Fill the four secret fields with independent random values. Keep the encryption key backed up separately. Configure provider credentials for the integrations you use.
3. Forward HTTPS from the proxy to the loopback or trusted LAN listener on `WEB_PORT` (default 8068). Do not expose that HTTP port directly to the internet. Register the Google callback at `APP_URL/api/v1/google/callback`.

Run from that directory in one shell:

```sh
set -eu
docker compose -f compose.yml config --quiet
docker compose -f compose.yml pull
docker compose -f compose.yml up -d --no-build --wait
docker compose -f compose.yml ps
```

Sign in through your HTTPS URL and confirm the sidebar version matches the image tag. To inspect the embedded release, run `docker compose exec web cat /app/VERSION` (also available in `api` and `worker`). No host version file or release variable is required.

For upgrades, back up the database, encryption key, and pending originals, and check migration compatibility. Preserve the private `.env`, project name, and named volumes. Pull the new release images, stop the worker before migrations, then start the stack. Never use `down -v` during an upgrade.
