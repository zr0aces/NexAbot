# Refresh LINE group name & sync Google Photos album title

**Status:** 2026-11-20 — Completed and verified (`typecheck`, `build`, `vitest`, `test-integration.sh` pass).

## Goal

Add a manual refresh action on each LINE group card in `LINE groups` (`/groups`) so the owner can fetch the latest group name from the LINE Messaging API (`GET /v2/bot/group/{groupId}/summary`), update `LineGroup.displayName`, and—if the group already has a mapped Google Photos album (`googleAlbumId`)—update the app-created Google Photos album title (`LINE - <new name>`) via `PATCH /v1/albums/{albumId}?updateMask=title`.

## Key constraints & design notes

- **Synchronous feedback**: Calling `POST /api/v1/groups/:id/refresh` directly from the API server lets the UI invalidate queries immediately and reflect the updated group name and album sync result.
- **Membership & credentials guard**: Require `g.membershipStatus === "JOINED"` and a configured LINE channel token (`lineCredentials().token`); validate the LINE response with Zod (`z.object({ groupName: z.string().min(1) })`), normalize/trim control characters and slice to `500` characters (`groupName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500)`), and reject empty post-trim names.
- **Preserve local rename on Google failure**: Commit `LineGroup.displayName` to the database *before* attempting the Google Photos `PATCH` and catch Google `Fault`s during album rename. That way, a transient Google error or rate limit never loses or blocks the LINE group name refresh; the response returns `{ ok: true, displayName, albumUpdated: false, albumError }` and the UI displays the saved group name plus the Google warning.
- **Google Photos OAuth scope & backwards compatibility**:
  - Updating an app-created album title via `PATCH https://photoslibrary.googleapis.com/v1/albums/{albumId}?updateMask=title` requires `https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata`.
  - Add `photoslibrary.edit.appcreateddata` to `scopes` in [packages/google-photos/index.ts](file:///home/san/workspace/RivoSnap/packages/google-photos/index.ts) and add `renameAlbum(id, name, token)` using `PATCH`.
  - If `g.googleAlbumId` is present:
    - When `googleConnection.status === "CONNECTED"` and `googleConnection.scopes.split(" ").includes("https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata")`, call `google.renameAlbum(g.googleAlbumId, google.title(displayName, g.lineGroupId), await access())`.
    - When `googleConnection.status === "CONNECTED"` but the connection predates `edit.appcreateddata`, return `albumError: "Reconnect Google Photos in Settings to sync the album title."`
    - When Google is not connected, return `albumError: "Connect Google Photos in Settings to sync the album title."`

## Task list

- [x] **1. Google Photos scope & `renameAlbum` helper** ([packages/google-photos/index.ts](file:///home/san/workspace/RivoSnap/packages/google-photos/index.ts)):
  - Add `"photoslibrary.edit.appcreateddata"` to `scopes` and export `editScope = "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata"`.
  - Update `api(path, access, body?, method?)` to accept an optional `method` parameter (defaulting to `body ? "POST" : "GET"`, supporting `"PATCH"`).
  - Add `export const renameAlbum = async (id: string, name: string, t: string) => z.object({ id: z.string().min(1) }).parse(await api("albums/" + encodeURIComponent(id) + "?updateMask=title", t, { title: name }, "PATCH")).id;`.
  - Update the OAuth scope error message in [apps/api/routes.ts](file:///home/san/workspace/RivoSnap/apps/api/routes.ts#L156-L159) to `"Grant all requested Google Photos permissions and offline access."`.
- [x] **2. API endpoint `POST /groups/:id/refresh`** ([apps/api/routes.ts](file:///home/san/workspace/RivoSnap/apps/api/routes.ts)):
  - Load `LineGroup` by `id(q)`. If `g.membershipStatus !== "JOINED"`, throw `Fault("GROUP_LEFT", "Bot is not a member of this LINE group.")`.
  - Verify `(await lineCredentials()).token` is present (throw `Fault("LINE_CONFIG", "Configure LINE credentials first.")` if missing).
  - Fetch `line("group/" + encodeURIComponent(g.lineGroupId) + "/summary", token)`, parse `z.object({ groupName: z.string().min(1) })`, and normalize `displayName = info.groupName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500)` (throw `Fault("LINE_SUMMARY", "LINE did not return a group name.")` if empty).
  - Persist `db.lineGroup.update({ where: { id: g.id }, data: { displayName } })`.
  - If `g.googleAlbumId` is set, check `db.googleConnection.findUnique({ where: { id: 1 } })`:
    - If `conn?.status === "CONNECTED"` and `conn.scopes.split(" ").includes(google.editScope)`, try `await google.renameAlbum(g.googleAlbumId, google.title(displayName, g.lineGroupId), await access())` (`albumUpdated = true`); on `Fault`, capture `albumError = e.message`.
    - Else if `conn?.status === "CONNECTED"`, set `albumError = "Reconnect Google Photos in Settings to sync the album title."`.
    - Else set `albumError = "Connect Google Photos in Settings to sync the album title."`.
  - Write `audit(albumUpdated ? "Group and Google album name refreshed" : "Group name refreshed", "group", g.id)` and return `{ ok: true, displayName, albumUpdated, albumError }`.
- [x] **3. Web UI refresh button** ([apps/web/src/workspace.tsx](file:///home/san/workspace/RivoSnap/apps/web/src/workspace.tsx)):
  - Extend `useAction().run` so the callback can optionally return a dynamic status string (falling back to `okMsg` when the callback returns a non-string).
  - In `Groups` (`/groups`), add a secondary `Refresh name` button (with `RefreshCw` icon from `lucide-react`) in a flex action row alongside `Enable/Pause collection`, disabled when `action.busy || g.membershipStatus === "LEFT"`.
  - Return the exact status message from the `/groups/:id/refresh` response:
    - `res.albumUpdated ? "Group and Google Photos album title refreshed." : res.albumError ? "Group name refreshed. " + res.albumError : "Group name refreshed."`
- [x] **4. Docs & verification** ([docs/GOOGLE_CLOUD_SETUP.md](file:///home/san/workspace/RivoSnap/docs/GOOGLE_CLOUD_SETUP.md), [docs/OWNER_GUIDE.md](file:///home/san/workspace/RivoSnap/docs/OWNER_GUIDE.md), [tests/pipeline.test.ts](file:///home/san/workspace/RivoSnap/tests/pipeline.test.ts)):
  - Document `photoslibrary.edit.appcreateddata` in `docs/GOOGLE_CLOUD_SETUP.md` and the group/album title refresh workflow in `docs/OWNER_GUIDE.md`.
  - Add an integration test in `tests/pipeline.test.ts` verifying `POST /api/v1/groups/:id/refresh` updates `LineGroup.displayName` and sends `PATCH /v1/albums/album?updateMask=title` with `{ title: "LINE - <newName>" }`.
  - Run `corepack pnpm typecheck`, `corepack pnpm test`, `corepack pnpm build`, and `bash scripts/test-integration.sh`; refresh the knowledge graph with `rtk proxy graphify update .`.
