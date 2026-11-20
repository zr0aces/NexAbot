# Frontend design refactor — Darkroom Contact Sheet & Archival Ledger

**Status:** 2026-11-20 — Implemented Tasks 1–8 (`typecheck`, `build`, `vitest` pass). Blocked on Task 9 E2E/visual inspection: host missing `libatk-1.0.so.0` for Playwright Chromium.

## Goal

Refactor all pages in `apps/web` from the generic cream/terracotta admin template into a cohesive **Darkroom Contact Sheet & Archival Ledger** interface that aligns with RivoSnap's `photo-peak.svg` emerald mark and separates **browsing memories** (Gallery, Albums, Lightbox) from **pipeline operations** (Dashboard, Upload queue, LINE groups, Settings, System health).

## Design tokens & constraints

- **Palette**:
  - Light (*Tangerine Lab*): `--bg: #FFFBF7`, `--surface: #FFFFFF`, `--surface-sunken: #FFF1E6`, `--line: #EEDFD3`, `--ink: #1C1613`, `--ink-muted: #6E5E55`, `--brand: #FF6B2C` (`--brand-ink: #180D06`, `--brand-link: #C2410C`)
  - Dark (*Neon Safelight*): `--bg: #131110`, `--surface: #1D1917`, `--surface-sunken: #0D0B0A`, `--line: #302925`, `--ink: #F5EFEA`, `--ink-muted: #A8998F`, `--brand: #FF7A3D` (`--brand-ink: #180D06`, `--brand-link: #FF9A6C`)
  - Signals: `--status-ok: #059669` / `#34D399`, `--signal-warn: #D97706` / `#FBBF24`, `--signal-err: #DC2626` / `#F87171`
- **Typography (zero external network / CSP-safe)**:
  - Display: `"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif` for Login thesis, page titles, and empty states (no external Google Fonts CDN links so `@fastify/helmet` CSP and air-gapped Docker deployments stay intact).
  - UI / Body: `system-ui, -apple-system, "Segoe UI", sans-serif` at `14.5px / 1.55`.
  - Telemetry: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` with `font-variant-numeric: tabular-nums` for `Asia/Bangkok` timestamps, byte counts, IDs, and queue states.
- **Accessibility & motion**:
  - Preserve `:focus-visible` `3px` outline using `--brand`, respect `@media (prefers-reduced-motion: reduce)`, and keep `role="status"` / `aria-live="polite"` for action feedback.
  - Clipboard copy helpers must guard for `navigator.clipboard` availability (LAN HTTP contexts) and guard optional `prefs?.webhook`.
- **E2E selector invariants** (`e2e/gallery.spec.ts`):
  - Keep exact accessible labels/roles: `Gallery`, `Dashboard`, `System health`, `Sign out`, `Sign in`, `Create owner account`, `Email`, `Password`, `Setup key`, `Status`, `Photo from <group>`, `No images found`, `<dialog>` viewer with `Escape` close.
  - Keep `.row` class on System health rows containing `worker` and `Online`.

## Task list

- [x] **1. Tokens, typography & theme meta** (`apps/web/index.html`, `apps/web/src/style.css`):
  - Update `<meta name="theme-color">` to `#FF6B2C` and configure font stacks.
  - Replace all color/surface/brand tokens in `style.css` for both light and `[data-theme="dark"]`, including `--signal-warn` and `--signal-err`.
  - Tune heading scale (`h1` utility scale vs login hero scale) and `tabular-nums` utility rules.
- [x] **2. App shell & navigation** (`apps/web/src/main.tsx`, `apps/web/src/style.css`, `packages/ui/button.tsx`):
  - Group sidebar navigation into *Library* (`Dashboard`, `Gallery`, `Albums`) and *Pipeline* (`LINE groups`, `Upload queue`, `Settings`, `System health`) with optional active queue badge.
  - Fix mobile header/nav layout so `Sign out` sits cleanly in a top flex bar instead of `position: absolute`.
  - Add compact `48px` workspace status bar with API connection dot, Google Photos status pill, and `Asia/Bangkok` indicator.
- [x] **3. Login & owner setup** (`apps/web/src/main.tsx`, `apps/web/src/style.css`):
  - Replace the flat brown `.entrySide` slab with a darkroom `#0D0B0A` contact-sheet preview motif and concise thesis copy.
  - Preserve exact `Email`, `Password`, `Setup key`, `Sign in`, and `Create owner account` labels/controls; add inline password length guidance (`12+ characters`) on setup.
- [x] **4. Dashboard & 3-phase onboarding** (`apps/web/src/workspace.tsx`, `apps/web/src/onboarding.tsx`):
  - Replace the 4 equal KPI boxes with a **3-Stage Ingestion Rail** (`LINE Groups` → `Staged / In Progress` → `Synced`) plus an attention link when `failed > 0`.
  - Refactor `Onboarding` from a blind 1-of-9 stepper into a **3-Phase Checklist** (Accounts & Credentials, Group Participation, First Sync Verification) with collapsible completed phases and inline webhook copy.
  - Add a segmented disk usage bar (`stagingBytes` + `thumbnailBytes` vs `freeBytes`) and monospace-aligned `Recent activity` log.
- [x] **5. Gallery & darkroom lightbox** (`apps/web/src/photos.tsx`, `apps/web/src/style.css`):
  - Add compact filter bar (`Group`, `Status`, `From`, `Through`) with active filter reset action while preserving `Status` combobox accessible name.
  - Style `.photo` cards as crisp contact-sheet frames with `1px` matte border, frame index/status pip for non-synced items, and preserved `Photo from <group>` accessible button text.
  - Upgrade `.viewer` `<dialog>` into a darkroom `#0D0B0A` lightbox with bottom monospace EXIF/telemetry strip and keyboard hints (`←` `→` `Esc`).
- [x] **6. Albums & LINE groups** (`apps/web/src/workspace.tsx`, `apps/web/src/style.css`):
  - Fix `.cover` bleed in `Albums` (`padding: 0` card with full-bleed `16/10` cover + layered top edge + padded footer).
  - Refactor `LINE groups` into scannable cards with `JOINED`/`LEFT` badge, `Collecting`/`Paused` toggle, copyable group/album ID, and inline confirmation checkbox for `albumCreating` resolution (replacing `window.confirm`).
- [x] **7. Upload queue** (`apps/web/src/photos.tsx`, `apps/web/src/style.css`):
  - Refactor `Library jobs` into operational triage rows with thumbnail preview, semantic state badge (`FAILED`, `NEEDS_REVIEW`, `PENDING`), error summary + `errorCode`, primary `Retry upload` / `Reconcile with Google` CTA, and inline two-step confirmation for `Discard expired original` (replacing `window.confirm`).
- [x] **8. Settings & System health** (`apps/web/src/workspace.tsx`, `apps/web/src/style.css`):
  - Convert `Settings` to a single-column (`max-width: 760px`) sectioned layout: Destination (Google Photos), Source (LINE Messaging API + copyable webhook), and Retention Policy (unit labels + safety callout).
  - Convert `Health` into semantic dependency status cards while keeping `.row` class and exact `"worker"` / `"Online"` text for E2E compatibility. Map `/health` values accurately: `database === "Online"` (ok), `redis === "PONG"` (ok), `worker === "Online"` (ok), `diskPressure === false` (ok; `true` = warning).
- [ ] **9. Verification**:
  - Run `corepack pnpm typecheck`, `corepack pnpm build`, `corepack pnpm test`, and `corepack pnpm e2e`.
  - Visually inspect desktop (`1440×900`) and mobile (`390×844`) layouts in light and dark themes via Playwright screenshots.
