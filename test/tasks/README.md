# Fixed real tasks

Three tasks, each taken from a real defect in this repository. The
before-and-after snapshots and the acceptance scripts are frozen.

| id | writable paths | acceptance command |
| --- | --- | --- |
| `rt02` | `src/ds/transport.ts`, `src/session/kernel.ts` | named cases from `test:protocol` and `test:session` |
| `rt03` | `src/proc/index.ts` | named cases from `test:effects` |
| `rt04` | `src/ds/sse.ts` | named cases from `test:protocol` |

## Running them

```sh
npm run test:acceptance                    # offline: no model, proves each task still fails→passes
DSH_LIVE=1 npm run test:live:acceptance    # let the model attempt all three
node test/tasks/run.mjs rt03               # one task (also needs DSH_LIVE=1)
node test/tasks/run.mjs --keep             # keep the run directory
node test/tasks/run.mjs --timeout 900      # wall-clock cap per task, default 1800s
```

A live run needs `npm run build` first and a `DEEPSEEK_API_KEY` in the
environment.

## What counts as a pass

Both conditions have to hold:

- the acceptance command exits with the code `tasks.json` records in
  `expectAfterFix`;
- nothing outside `writablePaths` was created, deleted or modified. `.dsh/` and
  `dist/` are the harness's own output and do not count.

The acceptance scripts are installed only after the model's process has exited.
The model never sees them, and never sees `solution.patch`.

## Layout

```
tasks.json        the three task definitions
prompts/          task descriptions
workspaces/       pre-fix repository snapshots, as tar
verifiers/        hidden test overlay plus the reference solution.patch
run.mjs           the runner
task-budget.ts    the acceptanceBudget implementation the Session Kernel uses
```

`run.mjs` bounds a run by wall clock only. It does not apply the token or cost
limits in `task-budget.ts`, because the CLI has no entry point for passing a
budget in. Watch the spend yourself; historically three tasks cost about
`$0.045`.

## Changing a task

After editing `tasks.json`, a prompt or an acceptance script, run
`npm run test:acceptance`. If the self-check fails the task itself is broken,
and any model run against it is meaningless.

Adjusting a task, loosening its acceptance or raising its budget *after* seeing
what the model did produces a number that means nothing.
