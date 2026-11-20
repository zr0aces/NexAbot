# NexAbot

A single-owner, private photo inbox for authorized personal LINE groups. New group images are staged, checked and uploaded into one Google Photos album per group. Google Photos is the only permanent home for originals.

**First time using NexAbot?** Follow the [step-by-step owner guide](docs/OWNER_GUIDE.md) to connect your accounts, collect your first photo, and manage groups and uploads.

## Quick start

1. Install Docker with Compose. Point DNS for `dnbot.zerotrust.in.th` to your HTTPS reverse proxy and provision its TLS certificate. Use `APP_URL=https://dnbot.zerotrust.in.th` for production, including when signing in from the LAN.
2. Copy the supplied environment template to Compose's private environment file. Set APP_URL, the matching redirect URI, OAuth credentials and a URL-safe database password. Generate **separate** values with `openssl rand -hex 32` for SESSION_SECRET, TOKEN_ENCRYPTION_KEY and BOOTSTRAP_SECRET. Restrict file permissions to the owner.
3. Run `docker compose up -d --build`. Forward https://dnbot.zerotrust.in.th to http://127.0.0.1:8068 from a same-host proxy, or to http://192.168.8.70:8068 from a LAN proxy. The host port defaults to 8068. To change it, set `WEB_PORT` in `.env`, run `docker compose up -d --no-deps web`, and update the proxy upstream. Leave bundled Caddy disabled. See [deployment](docs/DOCKER_DEPLOYMENT.md).
4. Open https://dnbot.zerotrust.in.th and claim the owner account. Follow the [owner setup steps](docs/OWNER_GUIDE.md#set-up-your-first-group) to save the LINE credentials **before** verifying the webhook, authorize Google Photos, and confirm your first synced image.

## Development and tests

Start with the [plan index](docs/plans/README.md) to find or propose work. Claude Code, Codex, and Antigravity share the [AI tool workflow](AGENTS.md#ai-tool-workflow).

The [versioning policy](AGENTS.md#versioning) specifies Bangkok-calendar CalVer for application releases. No release tooling is configured yet. The version in the OpenAPI document identifies the API contract, not an application release.

Node 24 LTS and pnpm 10 via Corepack. Run from the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm generate
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
bash scripts/test-integration.sh
corepack pnpm exec playwright install --with-deps chromium
corepack pnpm e2e
```

The integration script creates disposable PostgreSQL and Redis containers on loopback, applies migrations, and tests the authenticated webhook-to-gallery path against mocked providers. This test is skipped without the script's opt-in. Playwright runs its gallery fixture locally. To exercise owner login and worker health, set E2E_URL and E2E_SETUP_KEY for a **disposable deployment only**; the test creates a fixture owner.

For host development export server settings, point DATABASE_URL and REDIS_URL to dedicated instances, select writable cache directories, set NODE_ENV=development and APP_URL=http://localhost:5173. Run `corepack pnpm migrate`, then `corepack pnpm api`, `corepack pnpm worker`, and `corepack pnpm exec vite apps/web` in separate terminals. Use real HTTPS for live provider onboarding.

## Handbook

- [Architecture and retention](docs/ARCHITECTURE.md)
- [LINE setup](docs/LINE_SETUP.md)
- [Google Cloud setup](docs/GOOGLE_CLOUD_SETUP.md) and [OAuth restrictions](docs/GOOGLE_PHOTOS_OAUTH.md)
- [Docker, proxy, backup and restore](docs/DOCKER_DEPLOYMENT.md)
- [Security and privacy](docs/SECURITY.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

Signed-in API documentation: **/api/openapi.json**. Display timezone: Asia/Bangkok. Live LINE delivery, public TLS and Google consent require owner configuration and testing.
