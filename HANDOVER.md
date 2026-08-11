# HANDOVER — SimpleDSH

- **Date:** 2026-08-11
- **Repo:** `/Users/oye/Downloads/projects/SimpleDSH`, branch `main`
- **HEAD:** `02130f7e43b6a67b4244f20bf52eb749d16033a4` — "Submit a finished command on the first Enter" (2026-08-11 15:36:37 +0800)
- **Origin of this note:** a single read-only reconnaissance session. No coding task was assigned. Nothing in the tree was modified by that session except this file.

## 1. What was asked

1. (Chinese) "查看一下当前内容" — inspect and report the current state of the workspace.
2. "Write a handover note for whoever continues this work with no memory of it… This note is the only thing that survives."

## 2. What I changed, and where

- Created `HANDOVER.md` (this file) at the repo root and committed it as the **only** commit of this session.
- Nothing else: no source edits, no builds (`npm run build` not run), no tests run, no network calls, no live DeepSeek requests.

## 3. What I verified, and how

All of the following were read-only; the working tree was clean before and after (`git status --short` empty at the end).

| Command | Result |
|---|---|
| `git status` | `On branch main`, up to date with `origin/main`, `nothing to commit, working tree clean` |
| `git log --oneline -10` | 8 commits; latest `02130f7` (see header); oldest `a1c34cb SimpleDSH v0.1` |
| `git ls-files \| wc -l` | **222 tracked files** |
| `ls -la` | `.dsh/`, `.env` (0600, 53 bytes), `.github/workflows/`, `.npm/`, `dist/`, `dev/`, `node_modules/`, `plans/`, `release/`, `scripts/`, `src/`, `test/` |
| `find src test scripts plans -type f \| wc -l` | 206 source/test/plan files |
| `wc -l` on `src/` | ~26,993 lines first-party TS + 12,769 lines vendored `src/tui/` |
| Read in full | `README.md` (170 lines), `package.json`, `AGENTS.md`, `PLANS.md`, `.gitignore`, `test/tasks/tasks.json`, `scripts/blocked-stage.mjs`, `.github/workflows/ci.yml`, first 50 lines of `plans/07-recovery-observability-gate1.md` |
| `cat .env.example` | `DEEPSEEK_API_KEY=` |
| `git ls-files \| grep -E '^(dist\|release\|\.env\|node_modules)'` | only `.env.example` is tracked of those |

## 4. What is still open

- **No active coding task.** Nothing was assigned, nothing is half-done, nothing was reverted.
- **Stage 07 is the ACTIVE plan**: `plans/07-recovery-observability-gate1.md` (Gate 1 exit — recovery, observability, fail-closed effects, startup replay, `indeterminate` reconcile, read-only projections, cost ledger, freeze the `test/tasks` manifest). Its Lead-exclusive write scope: `PLANS.md`, the Plan, the Spec, `src/session/**`, `src/journal/**`, `src/lineage/**`, `src/ctx/snapshot.ts`, `src/tool/durability.ts`, `src/cli.ts`, `package.json`, `scripts/**`, shared live wiring. **Check that plan before touching any of those paths.**
- Stages 08–12 are `BLOCKED` in `PLANS.md` (08 permissions/file-containment/supply-chain → Gate 2 base; 09 compaction; 10 fork; 11 extensibility admission → Gate 3; 12 release hardening). Do not implement them ahead of their triggers.
- Sensible next sanity baselines (all offline, no API key needed): `npm test` (bootstrap), `npm run check`, `npm run test:acceptance`, then the per-area suites `test:protocol`, `test:journal`, `test:context`, `test:effects`, `test:session`, `test:recovery`.
- `release/simpledsh-0.1.0-rc.0.tgz` (268,555 bytes) exists; `npm run release` or the README curl→`npm install -g ./simpledsh.tgz` flow verifies it.

## 5. Expensive lessons — how this codebase actually works

### 5.1 The planning docs are NOT in git (most important)

`.gitignore` excludes `dev/`, `plans/`, `AGENTS.md`, `PLANS.md`, `dist/`, `release/`, `.dsh/`, `.env`, `node_modules/`, `*.tgz`. So the 222 tracked files **do not contain the planning stack**; a fresh clone lacks it. Everything below exists only in this working copy:

- `AGENTS.md` — repo collaboration/review/evidence rules
- `PLANS.md` — the stage index and authority order (in Chinese), plus the global stop conditions and agent-team roles (Plan Lead / Worker / Verification Worker / Reviewer)
- `plans/07-…12-*.md` — per-stage plans
- `dev/docs/` — `architecture-charter.md`, **`dsh-spec.md` (the only formal Engineering Spec, TypeScript)**, `gpt-dev-doc.md`, `pi-agent-harness-design-principles.md`, `pi-style-reviewer-system-prompt.md`, `verifier-design.md`

Authority order: `AGENTS.md` > `architecture-charter.md` > `dsh-spec.md` > active plan > research docs. **To change declared behavior, edit `dev/docs/dsh-spec.md` first, get a fresh independent review (verdicts `KEEP` / `NEED EVIDENCE` / `REJECT` / `REWORK` / `ACCEPT AFTER CUTS`), then change code.** Review is required for anything touching the system prompt, tool schema, context projection, cache lineage, provider-visible request shape, persistence/recovery/concurrency/side-effect/permission/sandbox semantics, or a new durable abstraction without a second caller.

### 5.2 Fixed contract — do not "improve" these

- Only backend: DeepSeek official OpenAI-format API, `POST https://api.deepseek.com/chat/completions`. Fixed identity: `model = "deepseek-v4-flash"`, `thinking = {"type":"enabled"}`, `reasoning_effort = "max"`. **No** Pro, no `high`, no model switching/routing/override, no provider abstraction, no AI SDK, no other providers, no `base_url` — these are contract changes, not runtime config.
- Pricing, dated 2026-08-05: cache hit `$0.0028` / cache miss `$0.14` per 1M input tokens, output `$0.28` per 1M tokens → `r = 50`. Table: `src/cost/flash-prices-v1.toml`; ledger in `src/cost/project.ts`.
- Credentials: read order `DEEPSEEK_API_KEY` env → project `.env` (must be gitignored, non-symlink, mode `0600`) → `~/.config/dsh/credentials` (0600). Only `CredentialLoader` reads `.env`; only `src/ds` touches the key at send time; tool child env is a closed allowlist that does **not** inherit the key; header captures are redacted. Credential values must never reach the model-visible Snapshot body, Journal, Artifacts, logs, diagnostics, Context, tool child env, or handover materials.
- `bash` runs as the current user with no sandbox — a documented product boundary, **not** a security guarantee. README: run inside a container/VM/separate account if isolation is needed.
- The append-only Journal is the single source of truth; session state, ledger, and screen are all projections of it. Never rewrite provider-visible old bytes, never re-materialize a retry request, never guess or blind-retry an `indeterminate` effect.

### 5.3 Build, packaging, tests

- Two-pass build: `node scripts/clean-dist.mjs && tsc -p src/tui/tsconfig.json && tsc -p tsconfig.json && node scripts/copy-runtime-assets.mjs`. The vendored TUI compiles under its own tsconfig.
- `npm run check` = build + `scripts/check-package.mjs` (packaging/supply-chain checks). CI (`.github/workflows/ci.yml`, ubuntu, Node 22): `npm ci --ignore-scripts` → `npm run check` → `npm run test:bootstrap` → `npm pack --dry-run`.
- `test:security` and `test:release` are **deliberate stubs**: `scripts/blocked-stage.mjs` prints `BLOCKED: Stage NN` and exits 2 until stages 08/12 are admitted. Not a regression.
- Live tests need `DSH_LIVE=1` plus prior authorization and a key: `test:live:protocol`, `test:live:acceptance`. Live authorization (2026-08-04): Flash/thinking/max only, no hard cost cap, first live request only after all durable-before-send tests pass.
- `test:acceptance` = three fixed offline tasks in `test/tasks/tasks.json`: `rt02` preview observer isolation, `rt03` native bash stream ownership, `rt04` co-located terminal usage — frozen prompt/workspace/verifier tars under `test/tasks/{prompts,workspaces,verifiers}/`; offline self-check proves fail→pass without a model. `test:live:acceptance` runs the model on them.
- On 2026-08-07, per user instruction, ~72k lines of evaluation machinery were deleted (`real-task-v1–v10`, `cache-comparator-v1–v10`, `pi-*`, `solvability-control-*`); their conclusions remain in `PLANS.md`/Plan 07/Spec but the code is gone and cannot be rerun.
- Install quirk: npm refuses URL tarballs (`EALLOWREMOTE`), so releases must be downloaded to a file first, then `npm install -g ./simpledsh.tgz`. The package declares **no** install-time scripts, by design (supply-chain posture).

### 5.4 Code layout

- Four tools, exactly: `bash`, `edit`, `read`, `write` (`src/bytes/tool-arguments.ts` line 6). Runtime in `src/tool/runtime.ts`; file mutations in `src/tool/file.ts`; effect durability in `src/tool/durability.ts`; native process in `src/proc/index.ts`; SSE transport in `src/ds/sse.ts`; verify gate in `src/verify/gate.ts` (`--verify`/`--protect`; verdict is `tampered` if protected paths moved before the check runs).
- Largest first-party files: `src/journal/bindings.ts` 2,666; `src/session/kernel.ts` 2,556; `src/lineage/prefix.ts` 1,783; `src/journal/schema.ts` 1,240; `src/tool/file.ts` 1,001; `src/artifact/internal-cas.ts` 921; `src/tool/runtime.ts` 890; `src/cli.ts` 820. Vendored `src/tui/` ≈ 12,769 lines (from pi @ `05bf9df`, MIT, `LICENSE.pi`, each file records its upstream path).
- Context/cache: `src/lineage/` (prefix + cache ABI), `src/ctx/` (projector, snapshot, user), `src/session/compaction.ts` (auto-compact at 512K prompt tokens; `/compact` writes the summary on the lineage being replaced, then starts a new lineage under the frozen system prompt — still append-only; `/clear` is display-only and keeps cache hits). `src/snapshot/`, `src/blob/`, `src/artifact/` (content-addressed CAS + tool-result projections), `src/cost/`.
- `package.json`: name `simpledsh`, version `0.1.0-rc.0`, `private: true`, `license: UNLICENSED`, `type: module`, engines `node >=22`, bin `dist/src/cli.js`. Declares 3 direct runtime deps (`get-east-asian-width@1.6.0`, `marked@18.0.5`, `smol-toml@1.7.1`) + 2 devDeps (`typescript@6.0.3`, `@types/node@22.20.1`); `npm-shrinkwrap.json` pins them.
- Working-copy state: `dist/` built 2026-08-11 15:36; `.dsh/sessions/` is the gitignored local session store; `.env` exists (53 bytes) — do not read or copy its value.

### 5.5 Standing rules for the next agent

- Metric priority (never trade a higher priority for a lower one silently): protocol/recovery/side-effect invariants → fixed-suite pass@1 → uncached input tokens per task → wall-clock.
- Before writing to any shared path, check `PLANS.md` and the active plan for the current Lead's exclusive scope. One writer per file, schema, serializer, registry, lockfile, root build file, and CI wiring.
- If you clone fresh, restore `AGENTS.md`, `PLANS.md`, `plans/`, `dev/docs/` from this working copy — they are not in git.
- Every change needs: baseline revision/dirty-state record, owned paths, diff summary, exact validation commands with exit codes, metric/invariant impact, evidence artifact paths, unresolved risks.
