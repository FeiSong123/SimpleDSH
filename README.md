<div align="center">

# FlashCoder

**Simple Harness for DeepSeek Models**

DeepSeek-native · Cache-first · Durable Sessions · Small by Design

[![Release](https://img.shields.io/badge/release-v0.1.0--rc.4-7c5cff?style=flat-square)](https://github.com/Owen718/FlashCoder/releases/tag/v0.1.0-rc.4)
[![CI](https://img.shields.io/github/actions/workflow/status/Owen718/FlashCoder/ci.yml?branch=main&style=flat-square&label=build)](https://github.com/Owen718/FlashCoder/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Owen718/FlashCoder?style=flat-square)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-42b883?style=flat-square)

[Quick Start](#quick-start) · [Why FlashCoder](#why-flashcoder) · [Commands](#commands) · [Design](#design) · [Security](#security)

<br>

<img src="docs/demo.gif" width="856" alt="FlashCoder running in the terminal">

</div>

FlashCoder is a focused coding agent that runs in your terminal and talks to
DeepSeek directly. It reads and edits files, runs shell commands, searches the
web when needed, and records every action in a durable session you can inspect,
resume, or recover.

It keeps the harness deliberately small so the model—not layers of agent
machinery—does the work.

> [!NOTE]
> FlashCoder is currently a **v0.1 release candidate** for macOS and Linux.
> It is distributed through GitHub Releases and is not on npm yet.

## Quick Start

Requires Node.js 22 or newer.

```sh
curl -fsSL https://github.com/Owen718/FlashCoder/releases/download/v0.1.0-rc.4/flashcoder-0.1.0-rc.4.tgz -o flashcoder.tgz
npm install -g ./flashcoder.tgz
flashcoder login
```

Then open a project and start coding:

```sh
cd your-project
flashcoder
```

<details>
<summary><strong>Why install from a downloaded tarball?</strong></summary>

Recent npm versions reject tarballs fetched directly from arbitrary URLs with
`EALLOWREMOTE`. Downloading first works across npm versions and gives you an
artifact you can inspect before installing.

The release is prebuilt. Installation only unpacks it: the package declares no
install-time scripts.

</details>

<details>
<summary><strong>How credentials are stored</strong></summary>

`flashcoder login` asks for a DeepSeek API key without echoing it, validates the
key with the provider, and stores it at
`~/.config/flashcoder/credentials` with mode `0600`.

Credentials are read in this order:

1. `DEEPSEEK_API_KEY`
2. A Git-ignored, mode-`0600` `.env` in the project root
3. The stored credentials file

Run `flashcoder logout` to remove the stored key.

</details>

## Why FlashCoder

<table>
<tr>
<td width="50%" valign="top">
<h3>DeepSeek-native</h3>
<p>Built directly around DeepSeek's API and model behavior—not through a generic
provider abstraction. The request format, reasoning controls, web search, cost
accounting, and context lifecycle are designed together.</p>
</td>
<td width="50%" valign="top">
<h3>Cache-first</h3>
<p>Request bytes are durable state. Prefixes grow by appending, retries reuse the
original snapshot, and planned cache breaks create a new lineage. FlashCoder
optimizes the quality–cost frontier, not cache hit rate at any price.</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>Durable Sessions</h3>
<p>Every message, tool call, artifact, cost, and safe boundary is journaled. Close
the terminal, interrupt a run, or come back tomorrow—the session remains
inspectable, resumable, and recoverable.</p>
</td>
<td width="50%" valign="top">
<h3>Small by Design</h3>
<p>Five tools. Six runtime dependencies. No plugin system. New machinery enters
the core only when a real caller fails without it.</p>
</td>
</tr>
</table>

## Work You Can See

Tool calls appear as they settle, followed by a compact ledger of the run:

```text
> fix the bug in calc.py and check it

● read calc.py
● edit calc.py
● bash python3 -c "from calc import add; assert add(2, 3) == 5"

Fixed calc.py: `return a - b` → `return a + b`, verified with three cases.

4 steps · 3 tools · $0.0002 · 5.9s
```

When completion needs an external verdict, let a command decide:

```sh
flashcoder run --verify "npm test" --protect test "fix the failing case"
```

`--verify` uses the command's exit code. `--protect` detects whether paths the
verdict depends on changed before verification, so a modified test cannot be
quietly presented as a pass.

## Commands

```text
flashcoder                        interactive, multi-turn
flashcoder run "<prompt>"         one turn, then exit
flashcoder sessions               list this workspace's sessions
flashcoder continue [session-id]  continue a finished session
flashcoder inspect <session-id>   project the durable facts, read-only
flashcoder recover <session-id>   take over an interrupted session
```

Inside the TUI:

```text
/help      keys and commands
/clear     clear the display, keep the conversation
/compact   summarize the conversation into a new lineage
/effort    set reasoning effort: low, high, max
/login     store a DeepSeek API key
/logout    remove the stored key
/session   pick and resume a workspace session
/exit      leave FlashCoder
```

`Enter` sends, `Shift-Enter` inserts a line, `@` completes workspace paths, and
`↑` / `↓` walk through previous messages. Text entered during a running turn is
queued for the next turn rather than spliced into an in-flight request.

## Design

### Evidence, not reconstruction

Request bytes are materialized once and never rebuilt from mutable state. Tool
results are the evidence that an action happened. If an action was not
recorded, FlashCoder does not pretend it occurred.

### The log is the runtime

Session state, the cost ledger, and the screen are projections of one append-only
journal. There is no parallel source of truth to drift out of sync.

### Interruption is a fact, not a crash

An interrupted run closes at its last safe boundary. Recovery continues from
recorded work instead of silently replaying actions that may already have taken
effect.

### Compaction also appends

The current lineage writes its own summary before a new lineage begins. The old
prefix remains replayable; no prior request byte is edited or deleted.

### Cache behavior stays visible

Cache eligibility, actual cache reads, planned breaks, cost, and lineage changes
remain observable. Provider cache hits are best-effort—FlashCoder does not turn
an architectural objective into a fake guarantee.

## Web Search

New sessions expose DeepSeek's official server-side `web_search` tool. When the
model needs information outside the workspace, FlashCoder performs a grounded
Responses API round and records the result like any other tool output.

Sessions keep a frozen tool ABI, so sessions created before web search was
introduced do not silently gain a new tool halfway through their history.

## Security

> [!WARNING]
> FlashCoder runs `bash` as your current user. It has the same filesystem and
> process authority you do. It is **not a sandbox**.

For stronger isolation, run FlashCoder inside a container, virtual machine, or
separate Unix account. Treat it with the same care as a script you intend to run
locally.

## From Source

```sh
git clone https://github.com/Owen718/FlashCoder
cd FlashCoder
npm install
npm run build
npm link
```

## Development

```sh
npm run build            # build the vendored TUI, then the strict project
npm run check            # build plus packaging and supply-chain checks
npm test                 # run every suite
npm run test:acceptance  # prove three fixed tasks fail → pass without a model
npm run release          # pack, install, and smoke-test the release tarball
```

Tests are grouped by contract under `test/`: `protocol`, `context`, `journal`,
`session`, `cli`, `effects`, `recovery`, and `cost`.

<details>
<summary><strong>Upgrading from SimpleDSH</strong></summary>

FlashCoder was named SimpleDSH through `v0.1.0-rc.2`. Existing durable state is
preserved rather than rewritten:

- Workspaces with `.dsh/` keep using it; new workspaces use `.flashcoder/`.
- `~/.config/dsh/credentials` remains readable until the next login migrates it.
- Existing sessions retain their frozen Cache ABI and continue without a cache
  break.

Remove the previous command with:

```sh
npm uninstall -g simpledsh
```

</details>

## Third-party Code

`src/tui/` is vendored from [Pi](https://github.com/badlogic/pi-mono) at
`05bf9df`, under the MIT License. Each vendored file records its upstream path;
the upstream license is included in `LICENSE.pi`.

FlashCoder is an independent project. It is not affiliated with, endorsed by,
or sponsored by DeepSeek.

## License

[MIT](LICENSE)
