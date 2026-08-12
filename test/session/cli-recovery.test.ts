import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { materializeAssistant } from "../../src/bytes/assistant.js";
import { DEEPSEEK_MODEL } from "../../src/bytes/request.js";
import type {
  CompletedDeepSeekResponse,
  DeepSeekUsage,
  ToolCall,
} from "../../src/ds/types.js";
import {
  createSessionPaths,
  openJournalReadOnly,
  type CanonicalTimestamp,
  type EffectId,
  type EventId,
  type EventIdentitySource,
  type SessionId,
  type ToolCallId,
} from "../../src/journal/index.js";
import type {
  WriterLeaseOwner,
} from "../../src/journal/lease.js";
import {
  recoverSessionFixture,
  runSessionFixture,
  SessionInterruptedError,
  SessionKernelError,
} from "../../src/session/index.js";

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const cliPath = resolve(projectRoot, "dist/src/cli.js");
const FIXED_AT = "2026-08-05T12:00:00.000Z" as CanonicalTimestamp;
const fixedClock = Object.freeze({ now: () => FIXED_AT });
const COMPLETED_STATUS_LINE =
  "$0.0000 · cache 90.00% · context 10\n";

interface TreeEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly mode: string;
  readonly size: string;
  readonly contentHash: string | null;
  readonly linkTarget: string | null;
}

function sessionId(fill: string): SessionId {
  return `ses_${fill.repeat(32)}` as SessionId;
}

function eventIds(fill: string): EventIdentitySource {
  let counter = 0;
  return Object.freeze({
    nextEventId: () => {
      counter += 1;
      return `evt_${fill.repeat(16)}${counter
        .toString(16)
        .padStart(16, "0")}` as EventId;
    },
  });
}

async function workspace(t: TestContext, label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `flashcoder-cli-${label}-`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function runCli(arguments_: readonly string[], cwd: string) {
  return spawnSync(process.execPath, [cliPath, ...arguments_], {
    cwd,
    encoding: "utf8",
    env: {},
    timeout: 5_000,
  });
}

function usage(rawFinishReason = "stop"): DeepSeekUsage {
  return Object.freeze({
    promptTokens: 10,
    promptCacheHitTokens: 9,
    promptCacheMissTokens: 1,
    completionTokens: 4,
    reasoningTokens: 1,
    rawFinishReason,
  });
}

function completedResponse(content: string): CompletedDeepSeekResponse {
  const reasoningContent = "deterministic completed CLI fixture";
  const toolCalls = Object.freeze([]);
  return Object.freeze({
    assistantBytes: materializeAssistant({
      content,
      reasoningContent,
      toolCalls,
    }),
    content,
    reasoningContent,
    toolCalls,
    usage: usage(),
    providerRequestId: "cli-recovery-fixture-request",
    responseModel: DEEPSEEK_MODEL,
    systemFingerprint: null,
    semanticDeltaCount: 1,
  });
}

function toolResponse(call: ToolCall): CompletedDeepSeekResponse {
  const reasoningContent = "prepare the deterministic CLI reconciliation fixture";
  const toolCalls = Object.freeze([call]);
  return Object.freeze({
    assistantBytes: materializeAssistant({
      content: "",
      reasoningContent,
      toolCalls,
    }),
    content: "",
    reasoningContent,
    toolCalls,
    usage: usage("tool_calls"),
    providerRequestId: "cli-reconciliation-fixture-request",
    responseModel: DEEPSEEK_MODEL,
    systemFingerprint: null,
    semanticDeltaCount: 1,
  });
}

async function createCompletedSession(
  root: string,
  id: SessionId,
  fill: string,
  content = "durable completed answer",
): Promise<void> {
  const response = completedResponse(content);
  await runSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    userInput: "Complete without tools.",
    turns: [
      Object.freeze({
        kind: "success" as const,
        response,
        fragments: Object.freeze([
          Object.freeze({ kind: "content" as const, text: response.content }),
        ]),
      }),
    ],
    clock: fixedClock,
    eventIds: eventIds(fill),
  });
}

async function seedIndeterminateEffect(
  root: string,
  id: SessionId,
  ids: EventIdentitySource,
  markerPath: string,
): Promise<EffectId> {
  const callId = "call_cli_reconcile" as ToolCallId;
  const call: ToolCall = Object.freeze({
    id: callId,
    type: "function",
    function: Object.freeze({
      name: "bash",
      arguments: JSON.stringify({
        command: `printf SHOULD_NOT_RUN >> ${JSON.stringify(markerPath)}`,
      }),
    }),
  });
  let appends = 0;
  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Create an ambiguous effect for the CLI reconciliation path.",
      turns: [
        Object.freeze({
          kind: "success" as const,
          response: toolResponse(call),
          fragments: Object.freeze([
            Object.freeze({ kind: "tool_call" as const }),
          ]),
        }),
      ],
      clock: fixedClock,
      eventIds: ids,
      persistenceControls: {
        fault: (point) => {
          if (point !== "append.after_sync_before_ack") return;
          appends += 1;
          if (appends === 17) throw new Error("crash after effect_prepared");
        },
      },
    }),
    (error: unknown) =>
      error instanceof SessionKernelError &&
      error.code === "durability_failure",
  );
  await assert.rejects(
    recoverSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      turns: [],
      clock: fixedClock,
      eventIds: ids,
    }),
    (error: unknown) =>
      error instanceof SessionInterruptedError &&
      error.reason === "effect_indeterminate",
  );
  const observed = await openJournalReadOnly(root, id);
  const effect = observed.recoveryView.effects.find(
    (candidate) =>
      candidate.toolCallId === callId && candidate.status === "indeterminate",
  );
  assert.ok(effect);
  return effect.effectId as EffectId;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function treeSnapshot(root: string): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function visit(path: string, relative: string): Promise<void> {
    const stats = await lstat(path, { bigint: true });
    const kind = stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : stats.isSymbolicLink()
          ? "symlink"
          : "other";
    entries.push(Object.freeze({
      path: relative,
      kind,
      mode: stats.mode.toString(),
      size: stats.size.toString(),
      contentHash: kind === "file" ? sha256(await readFile(path)) : null,
      linkTarget: kind === "symlink" ? await readlink(path) : null,
    }));
    if (kind !== "directory") return;
    for (const name of (await readdir(path)).sort()) {
      await visit(
        join(path, name),
        relative === "." ? name : `${relative}/${name}`,
      );
    }
  }
  await visit(root, ".");
  return Object.freeze(entries);
}

function jsonRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function childRecord(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = parent[key];
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("run prints the allocated Session id before CredentialLoader failure", async (t) => {
  const root = await workspace(t, "allocated-session");

  const result = runCli(["run", "offline prompt"], root);

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 3);
  assert.equal(result.stdout, "");
  const lines = result.stderr.split("\n");
  assert.match(lines[0] ?? "", /^flashcoder: session_id=ses_[0-9a-f]{32}$/u);
  assert.equal(lines[1], "flashcoder: credential_missing");
  assert.equal(lines[2], "");
});

test("inspect is credential-independent, byte-stable, and makes no filesystem mutation", async (t) => {
  const root = await workspace(t, "inspect-read-only");
  const id = sessionId("a");
  await createCompletedSession(root, id, "a");
  await symlink("missing-synthetic-credential", join(root, ".env"));
  const before = await treeSnapshot(root);

  const first = runCli(["inspect", id], root);
  const second = runCli(["inspect", id], root);

  for (const result of [first, second]) {
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.endsWith("\n"), true);
    assert.equal(result.stdout.slice(0, -1).includes("\n"), false);
  }
  assert.equal(second.stdout, first.stdout);
  const report = jsonRecord(first.stdout);
  assert.deepEqual(Object.keys(report).sort(), [
    "cost",
    "journal",
    "observation",
    "recovery",
    "sessionId",
    "v",
  ]);
  assert.equal(report["v"], 1);
  assert.equal(report["sessionId"], id);

  const observation = childRecord(report, "observation");
  assert.equal(observation["stable"], true);
  assert.equal(observation["leaseStable"], true);
  const initialLease = childRecord(observation, "initialLease");
  assert.equal(initialLease["state"], "absent");

  const journal = childRecord(report, "journal");
  assert.equal(journal["tornTail"], null);
  const events = journal["events"];
  assert.ok(Array.isArray(events));
  assert.equal(events.at(-1)?.type, "run_completed");

  const recovery = childRecord(report, "recovery");
  assert.equal(recovery["sessionId"], id);
  const runs = recovery["runs"];
  assert.ok(Array.isArray(runs));
  assert.equal(runs.at(-1)?.status, "completed");

  const cost = childRecord(report, "cost");
  assert.equal(cost["sessionId"], id);
  assert.equal(cost["requestModel"], DEEPSEEK_MODEL);
  assert.equal(cost["costCompleteness"], "complete");
  assert.deepEqual(cost["unavailableMetrics"], [
    "queue_wait",
    "appended_tokens",
    "current_prefix_tokens",
  ]);
  assert.deepEqual(await treeSnapshot(root), before);
});

test("recovering a deterministically completed Session never loads a credential", async (t) => {
  const root = await workspace(t, "recover-lazy-credential");
  const id = sessionId("b");
  const content = "recovered without provider access";
  await createCompletedSession(root, id, "b", content);
  await symlink("missing-synthetic-credential", join(root, ".env"));

  const result = runCli(["recover", id], root);

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, content);
  assert.equal(result.stderr, COMPLETED_STATUS_LINE);
});

test("recover refuses a stale writer lease until its exact inspected fingerprint is explicitly quarantined", async (t) => {
  const root = await workspace(t, "explicit-quarantine");
  const id = sessionId("c");
  const content = "completed after explicit quarantine";
  await createCompletedSession(root, id, "c", content);
  const paths = createSessionPaths(root, id);
  await mkdir(paths.writerLockDir, { mode: 0o700 });
  const staleOwner: WriterLeaseOwner = Object.freeze({
    v: 1,
    pid: 2_147_483_647,
    nonce: "d".repeat(32),
    acquiredAt: FIXED_AT,
  });
  const ownerBytes = `${JSON.stringify(staleOwner)}\n`;
  await writeFile(join(paths.writerLockDir, "owner.json"), ownerBytes, {
    encoding: "utf8",
    mode: 0o600,
  });

  const inspected = runCli(["inspect", id], root);
  assert.equal(inspected.status, 0);
  const report = jsonRecord(inspected.stdout);
  const observation = childRecord(report, "observation");
  const lease = childRecord(observation, "initialLease");
  assert.equal(lease["state"], "owner-observed");
  const fingerprint = lease["fingerprint"];
  assert.ok(
    typeof fingerprint === "string" && /^sha256:[0-9a-f]{64}$/u.test(fingerprint),
  );
  const beforeRefusal = await treeSnapshot(root);

  const refused = runCli(["recover", id], root);
  assert.equal(refused.status, 5);
  assert.equal(refused.stdout, "");
  // The refusal is the point, but so is telling the operator what to do next:
  // taking a lease is deliberate, and the code alone left nobody a way to find
  // out what has to be named.
  assert.equal(
    refused.stderr,
    `flashcoder: journal_lease_held\n` +
      `flashcoder:   the writer lease for ${id} is held by pid 2147483647 (acquired ${FIXED_AT}); the owner process is not running on this host,\n` +
      `flashcoder:   but on a shared filesystem the owner may still be alive on another machine\n` +
      `flashcoder:   quarantine the lease and retry, only if you are certain no other process is writing this session:\n` +
      `flashcoder:     flashcoder recover ${id} --quarantine-fingerprint ${fingerprint} --confirm-no-concurrent-start\n` +
      `flashcoder:   or, when the owner process died on this host:\n` +
      `flashcoder:     flashcoder recover ${id} --quarantine-stale\n`,
  );
  assert.deepEqual(await treeSnapshot(root), beforeRefusal);

  const recovered = runCli([
    "recover",
    id,
    "--quarantine-fingerprint",
    fingerprint,
    "--confirm-no-concurrent-start",
  ], root);
  assert.equal(recovered.status, 0);
  assert.equal(recovered.stdout, content);
  assert.equal(
    recovered.stderr,
    `flashcoder: writer_lease_quarantined=${fingerprint}\n${COMPLETED_STATUS_LINE}`,
  );
  await assert.rejects(lstat(paths.writerLockDir), { code: "ENOENT" });
  const sessionEntries = await readdir(paths.sessionDir);
  const quarantine = sessionEntries.find((name) =>
    name.startsWith(".writer-quarantine-"),
  );
  assert.ok(quarantine);
  assert.equal(
    await readFile(join(paths.sessionDir, quarantine, "writer.lock", "owner.json"), "utf8"),
    ownerBytes,
  );
});

test("recover --quarantine-stale removes a lease proven dead on this host and proceeds", async (t) => {
  const root = await workspace(t, "quarantine-stale");
  const id = sessionId("d");
  const content = "completed after quarantine-stale";
  await createCompletedSession(root, id, "d", content);
  const paths = createSessionPaths(root, id);
  await mkdir(paths.writerLockDir, { mode: 0o700 });
  const staleOwner: WriterLeaseOwner = Object.freeze({
    v: 1,
    pid: 2_147_483_647,
    nonce: "e".repeat(32),
    acquiredAt: FIXED_AT,
  });
  const ownerBytes = `${JSON.stringify(staleOwner)}\n`;
  await writeFile(join(paths.writerLockDir, "owner.json"), ownerBytes, {
    encoding: "utf8",
    mode: 0o600,
  });

  const inspected = runCli(["inspect", id], root);
  assert.equal(inspected.status, 0);
  const report = jsonRecord(inspected.stdout);
  const observation = childRecord(report, "observation");
  const fingerprint = childRecord(observation, "initialLease")["fingerprint"];

  const recovered = runCli(["recover", id, "--quarantine-stale"], root);
  assert.equal(recovered.status, 0);
  assert.equal(recovered.stdout, content);
  assert.equal(
    recovered.stderr,
    `flashcoder: writer_lease_quarantined=${fingerprint}\n${COMPLETED_STATUS_LINE}`,
  );
  await assert.rejects(lstat(paths.writerLockDir), { code: "ENOENT" });
  const sessionEntries = await readdir(paths.sessionDir);
  const quarantine = sessionEntries.find((name) =>
    name.startsWith(".writer-quarantine-"),
  );
  assert.ok(quarantine);
  assert.equal(
    await readFile(join(paths.sessionDir, quarantine, "writer.lock", "owner.json"), "utf8"),
    ownerBytes,
  );
});

test("recover --quarantine-stale refuses a live writer lease and leaves it alone", async (t) => {
  const root = await workspace(t, "quarantine-stale-live");
  const id = sessionId("f");
  const content = "must not complete";
  await createCompletedSession(root, id, "f", content);
  const paths = createSessionPaths(root, id);
  await mkdir(paths.writerLockDir, { mode: 0o700 });
  const liveOwner: WriterLeaseOwner = Object.freeze({
    v: 1,
    pid: process.pid,
    nonce: "f".repeat(32),
    acquiredAt: FIXED_AT,
  });
  const ownerBytes = `${JSON.stringify(liveOwner)}\n`;
  await writeFile(join(paths.writerLockDir, "owner.json"), ownerBytes, {
    encoding: "utf8",
    mode: 0o600,
  });
  const before = await treeSnapshot(root);

  const refused = runCli(["recover", id, "--quarantine-stale"], root);
  assert.equal(refused.status, 5);
  assert.equal(refused.stdout, "");
  assert.equal(
    refused.stderr,
    `flashcoder: writer lease is live: pid ${process.pid} is still running on this host; stop that flashcoder process instead of quarantining\n`,
  );
  assert.deepEqual(await treeSnapshot(root), before);
});

test("recover rejects --quarantine-stale combined with the fingerprint options", async (t) => {
  const root = await workspace(t, "quarantine-stale-exclusive");
  const id = sessionId("a");
  await createCompletedSession(root, id, "a", "unused");
  const fingerprint = "sha256:" + "0".repeat(64);

  const refused = runCli([
    "recover",
    id,
    "--quarantine-stale",
    "--quarantine-fingerprint",
    fingerprint,
    "--confirm-no-concurrent-start",
  ], root);
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr, "flashcoder: invalid_invocation\n");
});

test("reconcile preserves exact evidence bytes and reaches the durable Boundary before lazy credential failure", async (t) => {
  const root = await workspace(t, "reconcile-exact-evidence");
  const id = sessionId("e");
  const ids = eventIds("e");
  const markerPath = join(root, "must-not-run.txt");
  const effectId = await seedIndeterminateEffect(root, id, ids, markerPath);
  const before = await openJournalReadOnly(root, id);
  const attemptsBefore = before.replay.events.filter(
    (event) => event.type === "request_attempt_started",
  ).length;
  const interruptionsBefore = before.replay.events.filter(
    (event) => event.type === "run_interrupted",
  ).length;
  const evidenceText = `${JSON.stringify(
    {
      v: 1,
      effectId,
      resolution: "completed",
      statement: "operator independently verified completion",
      terminal: {
        status: "succeeded",
        code: "ok",
        exitCode: 0,
        signal: null,
        descendantsReaped: true,
      },
      records: [
        {
          stream: "stdout",
          enc: "b64",
          bytes: Buffer.from("exact operator output\n", "utf8").toString("base64"),
        },
      ],
    },
    null,
    3,
  )}\n`;
  const evidencePath = join(root, "operator evidence.json");
  await writeFile(evidencePath, evidenceText, "utf8");

  const result = runCli(["reconcile", id, evidencePath], root);

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 3);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${COMPLETED_STATUS_LINE}flashcoder: credential_missing\n`);
  await assert.rejects(lstat(markerPath), { code: "ENOENT" });

  const after = await openJournalReadOnly(root, id);
  const events = after.replay.events;
  const evidenceEvents = events.filter(
    (event) =>
      event.type === "artifact_published" &&
      event.payload.artifactType === "operator_evidence",
  );
  assert.equal(evidenceEvents.length, 1);
  const evidenceEvent = evidenceEvents[0];
  assert.ok(evidenceEvent?.type === "artifact_published");
  assert.deepEqual(
    await readFile(join(after.paths.sessionDir, evidenceEvent.payload.artifactRef)),
    Buffer.from(evidenceText, "utf8"),
  );
  const reconciliation = events.find(
    (event) =>
      event.type === "effect_reconciled" &&
      event.payload.effectId === effectId,
  );
  assert.ok(reconciliation?.type === "effect_reconciled");
  assert.equal(reconciliation.payload.resolution, "completed");
  if (reconciliation.payload.resolution !== "completed") {
    assert.fail("expected completed reconciliation");
  }
  assert.equal(
    reconciliation.payload.evidenceArtifactId,
    evidenceEvent.payload.artifactId,
  );
  const resultEvent = events.find(
    (event) =>
      event.type === "tool_result_committed" &&
      event.payload.effectId === effectId,
  );
  assert.ok(resultEvent?.type === "tool_result_committed");
  assert.equal(resultEvent.payload.sourceEventId, reconciliation.id);
  assert.ok(
    events.some(
      (event) =>
        event.type === "commit_boundary_created" &&
        event.payload.sourceEventIds.includes(resultEvent.id),
    ),
  );
  assert.equal(
    events.filter((event) => event.type === "request_attempt_started").length,
    attemptsBefore,
  );
  assert.equal(
    events.filter((event) => event.type === "run_interrupted").length,
    interruptionsBefore,
  );
});

test("reconcile with not_executed_denied never executes the command and feeds a static denied result", async (t) => {
  const root = await workspace(t, "reconcile-execute-denied");
  const id = sessionId("4");
  const ids = eventIds("4");
  const markerPath = join(root, "must-not-run.txt");
  const effectId = await seedIndeterminateEffect(root, id, ids, markerPath);
  const evidencePath = join(root, "evidence-denied.json");
  const evidenceText = `${JSON.stringify({
    v: 1,
    effectId,
    resolution: "not_executed_denied",
    statement: "operator refuses to execute this command",
  })}\n`;
  await writeFile(evidencePath, evidenceText, "utf8");

  const result = runCli(["reconcile", id, evidencePath], root);
  assert.equal(result.status, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /credential_missing/u);
  await assert.rejects(lstat(markerPath), { code: "ENOENT" });

  const after = await openJournalReadOnly(root, id);
  const events = after.replay.events;
  const reconciled = events.find(
    (event) =>
      event.type === "effect_reconciled" &&
      event.payload.effectId === effectId,
  );
  assert.ok(reconciled?.type === "effect_reconciled");
  assert.equal(reconciled.payload.resolution, "not_executed_denied");
  assert.equal(
    events.filter(
      (event) =>
        event.type === "effect_prepared" &&
        event.payload.toolCallId === "call_cli_reconcile",
    ).length,
    1,
  );
  const committed = events.filter(
    (event) => event.type === "tool_result_committed",
  );
  assert.equal(committed.length, 1);
  const resultEvent = committed[0];
  assert.ok(resultEvent?.type === "tool_result_committed");
  assert.equal(resultEvent.payload.effectId, null);
  assert.equal(resultEvent.payload.artifactId, null);
  assert.equal(resultEvent.payload.sourceEventId, reconciled.id);
  assert.ok(
    events.some(
      (event) =>
        event.type === "commit_boundary_created" &&
        event.payload.sourceEventIds.includes(resultEvent.id),
    ),
  );
});

test("recover reports a session outside the current workspace instead of a bootstrap error", async (t) => {
  const root = await workspace(t, "recover-wrong-workspace");
  const other = await workspace(t, "recover-other-workspace");
  const id = sessionId("b");
  await createCompletedSession(root, id, "b", "unused");

  const refused = runCli(["recover", id], other);
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /no such session in this workspace/u);
  assert.match(refused.stderr, /searched/u);

  const inspected = runCli(["inspect", id], other);
  assert.equal(inspected.status, 2);
  assert.equal(inspected.stdout, "");
  assert.match(inspected.stderr, /no such session in this workspace/u);
});

test("reconcile refuses to execute a pending tool call without --confirm-execute, and runs it exactly once with it", async (t) => {
  const root = await workspace(t, "reconcile-execute-confirm");
  const id = sessionId("9");
  const ids = eventIds("9");
  const markerPath = join(root, "must-not-run.txt");
  const effectId = await seedIndeterminateEffect(root, id, ids, markerPath);
  const evidencePath = join(root, "evidence.json");
  const evidenceText = `${JSON.stringify({
    v: 1,
    effectId,
    resolution: "proven_not_executed",
    statement: "operator verified the command never ran",
  })}\n`;
  await writeFile(evidencePath, evidenceText, "utf8");

  const refused = runCli(["reconcile", id, evidencePath], root);
  assert.equal(refused.status, 5);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /recovery will execute the pending tool call/u);
  assert.match(refused.stderr, /printf SHOULD_NOT_RUN/u);
  assert.match(
    refused.stderr,
    /recovery_execution_requires_confirmation/u,
  );
  assert.match(refused.stderr, /recovery_execution_denied/u);
  await assert.rejects(lstat(markerPath), { code: "ENOENT" });

  const confirmed = runCli(
    ["reconcile", id, evidencePath, "--confirm-execute"],
    root,
  );
  assert.equal(confirmed.status, 3);
  assert.match(confirmed.stderr, /recovery will execute the pending tool call/u);
  assert.match(confirmed.stderr, /credential_missing/u);
  await assert.doesNotReject(lstat(markerPath));
  const markerContent = await readFile(markerPath, "utf8");
  assert.equal(markerContent, "SHOULD_NOT_RUN");

  const after = await openJournalReadOnly(root, id);
  const committed = after.replay.events.filter(
    (event) => event.type === "tool_result_committed",
  );
  assert.equal(committed.length, 1);
  const boundaries = after.replay.events.filter(
    (event) =>
      event.type === "commit_boundary_created" &&
      event.payload.sourceEventIds.includes(committed[0]!.id),
  );
  assert.equal(boundaries.length, 1);
});
