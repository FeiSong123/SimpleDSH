# SimpleDSH

A simple harness for DeepSeek.

SimpleDSH is a coding agent that runs in your terminal and talks to
`api.deepseek.com` directly. It reads and edits files, runs shell commands, and
writes down everything it did in a form you can replay.

Status: v0.1 release candidate. Not yet published to npm.

## Install

Node 22 or newer.

```sh
git clone <repo> && cd SimpleDSH
npm install
npm run build
npm link
simpledsh login
```

`simpledsh login` prompts for a DeepSeek API key without echoing it, checks it
against the provider before saving, and writes it to
`~/.config/dsh/credentials` with mode `0600`. That path is outside any
repository, so the key cannot be committed by accident. `simpledsh logout`
removes it.

The key is read from, in order: the `DEEPSEEK_API_KEY` environment variable, a
`.env` at the project root, then the stored file. A project `.env` must be
Git-ignored and mode `0600` or startup refuses.

## Use

```
simpledsh                        interactive, multi-turn
simpledsh run "<prompt>"         one turn, then exit
simpledsh sessions               list this workspace's sessions
simpledsh continue [session-id]  add a turn to a finished session
simpledsh inspect <session-id>   read-only projection of the durable facts
simpledsh recover <session-id>   take over a session whose last run was interrupted
```

Every tool call is shown as it settles:

```
> fix the bug in calc.py and check it
● read calc.py
● edit calc.py
● bash python3 -c "from calc import add; assert add(2, 3) == 5"
Fixed calc.py: `return a - b` → `return a + b`, verified with three cases.
4 steps · 3 tools · $0.0002 · 5.9s
```

In interactive mode `Enter` sends and `Shift-Enter` adds a line. Typing while a
turn is running queues the message: it is sent as the next turn once the current
one closes, never spliced into a request already in flight. `Ctrl-C` interrupts
the running turn, then clears the input, then clears the queue. `@` completes a
workspace path, `/` lists the built-in commands, `↑`/`↓` walk earlier messages,
`Ctrl-D` exits.

To let a command decide whether the work stands up:

```sh
simpledsh run --verify "npm test" --protect test "fix the failing case"
```

## Design

**Nothing is invented.** Request bytes are materialized once and never rebuilt.
Tool results are the only evidence that an action occurred. If it was not
recorded, it did not happen.

**The log is the runtime.** Every run appends to a session log: the exact
request bytes, each assistant message, each tool call and artifact, the cost,
and where the run safely closed. Session state, the ledger and the screen are
all projections of it. There is no second source of truth, so closing the
terminal loses nothing.

**Append-only, so the cache holds.** A conversation only ever grows at the end.
The byte prefix therefore never changes and stays eligible for DeepSeek's
context cache across turns. The hit ratio sits on the status line next to cost,
because that ratio is the difference between a cheap session and an expensive
one.

**Interruption is a fact, not a crash.** A run that stops part-way closes at its
last safe boundary. The next turn continues from there instead of replaying work
that already happened.

**The agent does not get to say it is done.** With `--verify`, a command's exit
code decides. `--protect` names the paths that command depends on; if they moved
by the time it runs, the verdict is `tampered` rather than `passed`. This
detects rather than prevents — it cannot stop a model editing the tests, but it
will not call that a pass.

**Small on purpose.** Four tools, six runtime dependencies, no plugin system.
Things get added when there is a caller that fails without them.

## Bash execution boundary

`bash` runs directly as the current user, with the same authority you have. It
can read any file your account can read, including credentials outside the
workspace, and its writes are not confined to the project directory.

There is no sandbox. If you need one, run SimpleDSH inside a container, a
virtual machine, or a separate Unix account. Treat it as you would treat running
a script someone sent you.

## Development

```sh
npm run build            # two passes: the vendored TUI, then the strict project
npm run check            # build, then the packaging and supply-chain checks
npm test                 # every suite
npm run test:acceptance  # three fixed tasks, proved fail→pass without a model
```

Tests are grouped by area under `test/`: `protocol`, `context`, `journal`,
`session`, `cli`, `effects`, `recovery`, `cost`.

## Third-party code

`src/tui/` is vendored from [pi](https://github.com/earendil-works/pi) at
`05bf9df`, MIT, Copyright (c) 2025 Mario Zechner. Each file records its
upstream path; the licence is in `LICENSE.pi`.

SimpleDSH is an independent project. It is not affiliated with, endorsed by, or
sponsored by DeepSeek.
