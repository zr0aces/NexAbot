# Troubleshooting

| Symptom | Operator action |
|---|---|
| Setup denied | Use the deployment's bootstrap key only for first claim. If an owner exists, sign in. A mismatched APP_URL or proxy rewriting Origin blocks browser writes. |
| Webhook Verify fails | Check public TLS, exact URL, unmodified body and matching channel secret. Enable redelivery. A full staging disk returns a temporary error rather than dropping images. |
| Missing group | Enable LINE group participation and invite the correct Official Account. Direct messages and rooms never register. An already joined group can be discovered by a new group image but stays disabled. |
| No image after enabling | Send a **new image** after enablement. Check membership, configuration and worker heartbeat. LINE_404/410 means content is no longer available; sending a new image is required. |
| OAuth consent fails | Match redirect URI exactly, enable Library API, add test user if needed, grant both scopes. Reauthorize the original account/project after invalid_grant. |
| Rate limit/network | Wait for bounded backoff and Retry-After. Inspect the queue and health before retrying. Do not replay the original webhook to force another upload. |
| Album capacity or account storage | Resolve the provider limit, then retry FAILED. No overflow album is created; changing strategy needs explicit approval. |
| ALBUM_REVIEW | Inspect the app-created destination albums in Google. In LINE groups resolve the flag using a verified **Library API album ID**, not the browser sharing URL. Leave it blank only after confirming no album was created. Retry the failed image. Never guess based solely on a title. |
| NEEDS_REVIEW | Inspect the expected app-assigned filename (line- plus internal image UUID and extension). Reconcile performs a read-only exact filename search in the mapped album. No unique match leaves the job in review; it does not upload again. Do not resubmit to bypass review. |
| Disk pressure | Free unrelated files or expand the volume. Resolve uploads, wait for synced cleanup, or explicitly discard an expired stopped original after inspecting it. Do not manually delete active staging files. Discard is irreversible and never deletes Google Photos media. |
| Cache miss | Synced images are served by resolving their Google IDs. Reconnect and Validate if remote reads fail. A manually deleted or moved remote item may no longer resolve. |
| Stale worker | Check worker logs, Redis AOF volume and PostgreSQL readiness. Restart worker; unacknowledged outbox rows replay. Never flush production Redis or drop the outbox to clear the queue. |

## Check the network path

These commands assume the default `WEB_PORT=8068`. If you changed it in `.env`, substitute the port shown by `docker compose ps web` in both HTTP checks and in the proxy upstream.

1. On the app host, run `docker compose ps` and `curl -fsS http://127.0.0.1:8068/api/v1/auth/status`. Expect HTTP 200 with setup and authentication flags; no credentials are needed.
2. From the LAN proxy, run `curl -fsS http://192.168.8.70:8068/api/v1/auth/status`. If only this hop fails, check the host address, port binding, routing and firewall.
3. From outside the LAN, run `curl -fsS https://dnbot.zerotrust.in.th/api/v1/auth/status`. If DNS fails, check the public record. A certificate error points to proxy TLS configuration; a 502 generally points to the proxy's upstream. Do not fix these by exposing the published web port publicly or disabling secure cookies.

## First live acceptance

Sign in over HTTPS → verify worker online → connect Google → invite bot → explicitly enable a test group → send a personal test photo. Confirm one image, its expected album, SYNCED status and private thumbnail. In a signed-out browser the content endpoint must return 401. Test the real OAuth consent and provider account quotas before relying on ongoing collection; mocks cannot verify them.
