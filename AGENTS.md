# NexAbot project instructions

Keep project rules here. Claude Code imports this file through CLAUDE.md; Codex and Antigravity use it directly or through GEMINI.md. Use Node 24 and the root pnpm workspace through Corepack.

- For ingestion, uploads, retries or cleanup, read docs/ARCHITECTURE.md. Collect only new images from enabled LINE groups. Preserve channel/message deduplication and the transactional outbox. Reconcile uncertain Google writes instead of repeating them. Never silently delete an unuploaded original.
- For authentication, OAuth or media access, read docs/SECURITY.md. Keep secrets server-side. Do not print private environment files or expanded Compose configuration.
- For deployment changes, read docs/DOCKER_DEPLOYMENT.md. Keep one Nginx web service, the existing host bindings and WEB_PORT contract. Do not remove named volumes or run tests against production.
- Check TypeScript changes with `corepack pnpm typecheck` and focused tests. For pipeline changes run `bash scripts/test-integration.sh` against disposable services; for UI behavior use Playwright as described in README.md. Check Compose edits with `docker compose --profile edge config --quiet`.

## Plans

When creating, revising, or shipping an implementation plan, follow the [plan index and filing rules](docs/plans/README.md). Keep the task list inside the plan rather than maintaining a second checklist.

## AI tool workflow

- **RTK:** Prefix each shell command with `rtk`, including each command in a chain. Follow /home/san/.codex/RTK.md on the deployment host. Do not assume a client hook supplies the prefix.
- **Graphify:** If `graphify-out/` and the CLI are available, use `graphify query`, `graphify path`, or `graphify explain` before broad searches for architecture or cross-module questions. Consult `graphify-out/GRAPH_REPORT.md` if the result lacks context. After changing code, refresh an existing graph with `rtk proxy graphify update .`. See `## graphify` below for complete rules.
- **Caveman:** Keep replies concise while preserving technical facts, exact paths, commands and errors. Write docs, commits and PRs in normal prose. Explain security warnings and irreversible actions clearly rather than abbreviating them.

## Versioning

- Application release policy: use root `VERSION` as the sole authority for CalVer `YYYY.M.N`, where the year and month follow Asia/Bangkok and N is the release sequence within that month. A release check must fail if the source is missing or malformed; never infer a version from a package manifest.
- Keep check, prepare and publish separate. Check is read-only. Prepare advances the version, synchronizes owned release metadata and checks it; it does not build, install, commit, tag or push. Creating an annotated local tag or publishing requires explicit authorization.
- Use the repository-local scripts: `node scripts/sync-version.mjs --check` validates, and `node scripts/release.mjs` prepares only. The optional `--build` runs the workspace build, not a production deployment. NexAbot’s OpenAPI version identifies the API contract; do not bump it for a calendar release.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
