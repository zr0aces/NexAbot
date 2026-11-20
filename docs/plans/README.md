# NexAbot plan index

Add a link under **Active** when a plan is created; move it to **Completed** when the work ships. Completing a plan does not bump the application version; see the [release policy](../../AGENTS.md#versioning).

## Active

None.

## Completed

None.

## Filing rules

1. Keep active plans in this directory. Name each file with its actual creation date: `YYYY-MM-DD-<issue>-<slug>.md`. If there is no issue, omit that segment rather than inventing an ID.
2. Immediately below the title, add a **Status:** line with the date, what shipped and what remains. Put the only implementation checklist under `## Task list`.
3. If a plan needs a separate design, link it under `specs/`. Put standing backlog in `roadmap.md`; create it when there is an item to track.
4. On shipment, move the plan to `completed/` and its paired design to `completed/specs/`. Update the status and links together. Preserve the files; use `git mv` when tracked.
5. Correct inaccurate claims inline: strike through the original and give the correction alongside it. Record dated review fixes with no associated plan in `docs/development/review-fix-log.md`, creating the log on first use.
