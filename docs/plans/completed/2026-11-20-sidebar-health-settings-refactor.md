# Sidebar System Health & Settings pipeline refactor

**Status:** 2026-11-20 — Shipped. Sidebar live color-dot health strip and Pipeline Bridge Settings layout implemented; `typecheck`, `build`, and `vitest` pass.

## Goal

Move live **System health** telemetry into the persistent sidebar with semantic color dots (`#059669` / `#D97706` / `#DC2626`) while keeping `/health` accessible for E2E compatibility, and refactor **Settings** into a scannable **Source → Destination → Retention** Pipeline Bridge layout using the existing *Tangerine Lab* / *Neon Safelight* tokens.

## Constraints & E2E invariants

- **E2E (`e2e/gallery.spec.ts`)**:
  - Keep `<Link to="/health">System health</Link>` accessible and keep `.row` elements on `/health` containing `worker` and `Online`.
- **API contracts (`apps/api/routes.ts`)**:
  - `/health` returns `{ database: "Online", redis: "PONG" | string, worker: "Online" | "Heartbeat missing", diskPressure: boolean }`.
  - `/settings/line` expects `{ token, secret }`; `/settings` PATCH expects numeric `{ stagingHours, failedDays, thumbnailDays }`.
- **Responsive & Accessibility**:
  - Collapse sidebar health block into a compact 4-dot indicator on mobile (`<=820px`) so mobile nav stays single-row.
  - Guard `prefers-reduced-motion` and keep `:focus-visible` outlines.

## Task list

- [x] **1. Sidebar live System Health strip** (`apps/web/src/main.tsx`, `apps/web/src/workspace.tsx`, `apps/web/src/style.css`):
  - Export `healthStatus` from `workspace.tsx` and reuse it in a `<SidebarHealth />` component mounted inside `aside` (only when authenticated, avoiding unauthenticated `/health` 401 reload loops).
  - Render a compact **System Pulse** ledger in `aside` above `.asideFooter` with header link `<Link to="/health">System health</Link>` and 4 live rows (`database`, `redis`, `worker`, `diskPressure`), each with an 8px semantic color dot (`ok`, `warn`, `err`) and monospace status.
  - Render a compact 4-dot summary link to `/health` in `.mobileActions` on mobile (`<=820px`) and hide the full sidebar ledger on mobile.
  - Remove `System health` from the main `PIPELINE` nav list since the sidebar widget owns it.
- [x] **2. Settings "Pipeline Bridge" refactor** (`apps/web/src/workspace.tsx`, `apps/web/src/style.css`):
  - Replace the 3-card vertical stack with a `max-width: 960px` two-tier layout:
    - Top 2-column **Connections Bridge**: `LINE Messaging API` (Source) → `Google Photos` (Destination).
    - Collapse `Access token` / `Channel secret` inputs behind an `"Update credentials"` toggle when `d.lineConfigured === true` (auto-expanded when unconfigured); keep Webhook URL + `CopyButton` always visible.
    - Adapt Google Photos actions by connection state (`Connect Google Photos` vs `Validate connection` + `Reconnect` + `Disconnect`).
    - Bottom **Local Cache & Retention** panel with 3-column horizontal numeric grid (`hours`, `days` unit suffixes) + safety note.
  - Keep `role="status" aria-live="polite"` feedback visible near the Settings heading.
- [x] **3. Verification**:
  - Run `corepack pnpm typecheck`, `corepack pnpm build`, and `corepack pnpm test`.
