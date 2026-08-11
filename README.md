# SimpleDSH

A cache-first, crash-recoverable coding agent for DeepSeek.

SimpleDSH is a coding agent that runs in your terminal and talks to
`api.deepseek.com` directly. It reads and edits files, runs shell commands, and
writes down everything it did in a form you can replay.

Status: v0.1 release candidate. Installed from a GitHub release; not on the
npm registry yet.

## Install

Node 22 or newer, on macOS or Linux.

```sh
curl -fsSL https://github.com/Owen718/SimpleDSH/releases/download/v0.1.0-rc.2/simpledsh-0.1.0-rc.2.tgz -o simpledsh.tgz
npm install -g ./simpledsh.tgz
simpledsh login
```

Download first, then install from the file. Recent npm refuses to fetch tarballs
from arbitrary URLs — `npm error code EALLOWREMOTE` — and this way works on
every version, on a file you can inspect before installing it.

The release is prebuilt, so installing unpacks it and nothing else. This
package declares no install-time scripts and never will — running a build on
your machine during `npm install` is the shape of supply-chain problem this
project avoids elsewhere, so it is not going to introduce one here.

`simpledsh login` prompts for a DeepSeek API key without echoing it, checks it
against the provider before saving, and writes it to
`~/.config/dsh/credentials` with mode `0600`. That path is outside any
repository, so the key cannot be committed by accident. `simpledsh logout`
removes it.

The key is read from, in order: the `DEEPSEEK_API_KEY` environment variable, a
`.env` at the project root, then the stored file. A project `.env` must be
Git-ignored and mode `0600` or startup refuses.

### From source

```sh
git clone https://github.com/Owen718/SimpleDSH && cd SimpleDSH
npm install
npm run build
npm link
```

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
workspace path, `↑`/`↓` walk earlier messages, `Ctrl-D` exits.

`/` lists the built-in commands:

```
/help      keys and commands
/clear     empty the screen, keep the conversation
/compact   replace the conversation with a summary of itself
/effort    how hard the model thinks: low, high, max
/login     store a DeepSeek API key
/logout    remove the stored key
/session   list this workspace's sessions
/exit      leave, and /quit does the same
```

`/clear` is display only — the session, its byte prefix and every durable fact
are untouched, and the next turn is still a cache hit. `/compact` is the one
that changes what gets sent; it also runs on its own once the prefix reaches
512K prompt tokens, because the model gets noticeably worse as it approaches
its 1M window. `--auto-compact-tokens <n>` moves that point, and `0` turns it
off.

`/effort` opens a slider. Changing it mid-session is allowed and costs a cache
break: reasoning effort is part of the frozen prefix, so a new level means a new
Cache ABI and a new lineage. The conversation carries across as a summary, the
same way compaction does, and the next turn starts cold on purpose.

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

**Cache is a first-class architectural concern.** The exact request bytes sent
to DeepSeek are durable state, not something rebuilt from mutable objects. A
conversation only ever grows at the end, retries reuse the original request
snapshot, and planned breaks such as compaction start a new lineage instead of
silently changing an old prefix. This maximizes cache-hit eligibility and makes
accidental breaks detectable. Actual cache hits remain best-effort and under
the provider's control; the measured hit ratio sits next to cost on the status
line.

**Interruption is a fact, not a crash.** A run that stops part-way closes at its
last safe boundary. The next turn continues from there instead of replaying work
that already happened.

**Even compaction only appends.** Replacing a long conversation with a summary
is the one operation that could be a rewrite, and it is not one. The model
writes the summary on the lineage being replaced — so reading the whole history
is still a cache hit — and only then does a new lineage start under the same
frozen system prompt and tools. No byte is deleted or edited; the old prefix
stays replayable and simply stops being sent.

**The agent does not get to say it is done.** With `--verify`, a command's exit
code decides. `--protect` names the paths that command depends on; if they moved
by the time it runs, the verdict is `tampered` rather than `passed`. This
detects rather than prevents — it cannot stop a model editing the tests, but it
will not call that a pass.

**Small on purpose.** Five tools, six runtime dependencies, no plugin system.
Things get added when there is a caller that fails without them.

## Web search

New sessions declare a `web_search` tool backed by DeepSeek's official web
search. DeepSeek's search is a server-side `web_search` tool in the Responses
API (`/responses`) — the chat completions API only accepts `function` tools and
there is no client-side search endpoint. When the model decides the answer
needs facts the workspace cannot provide, it calls `web_search` with a
`search_query`; SimpleDSH sends one Responses API round with the same
credential and the built-in `web_search` tool, and feeds the provider's
search-grounded answer back as the tool result. Sessions opened before this
feature keep their frozen tools ABI and never search.

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
npm run release          # pack, then install and run the tarball to prove it works
```

Tests are grouped by area under `test/`: `protocol`, `context`, `journal`,
`session`, `cli`, `effects`, `recovery`, `cost`.

## Third-party code

`src/tui/` is vendored from [pi](https://github.com/earendil-works/pi) at
`05bf9df`, MIT, Copyright (c) 2025 Mario Zechner. Each file records its
upstream path; the licence is in `LICENSE.pi`.

SimpleDSH is an independent project. It is not affiliated with, endorsed by, or
sponsored by DeepSeek.
