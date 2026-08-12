import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import { materializeAssistant } from "../../src/bytes/assistant.js";
import { DEEPSEEK_MODEL } from "../../src/bytes/request.js";
import type {
  CompletedDeepSeekResponse,
  DeepSeekUsage,
  ToolCall,
} from "../../src/ds/types.js";
import {
  openJournal,
  type AnyVerifiedJournalEvent,
  type CanonicalTimestamp,
  type EventId,
  type EventIdentitySource,
  type SessionId,
} from "../../src/journal/index.js";
import {
  recoverSessionFixture,
  runSessionFixture,
  SessionInterruptedError,
  SessionKernelError,
} from "../../src/session/index.js";

const FIXED_AT = "2026-08-05T08:00:00.000Z" as CanonicalTimestamp;
const fixedClock = Object.freeze({ now: () => FIXED_AT });
const REPO_ROOT = resolve(process.cwd());
const LEGACY_V4_REVISION = "3273e50";

function sessionId(fill: string): SessionId {
  return `ses_${fill.repeat(32)}` as SessionId;
}

function eventIds(fill: string): EventIdentitySource {
  let counter = 0;
  return Object.freeze({
    nextEventId: () => {
      counter += 1;
      const suffix = counter.toString(16);
      return `evt_${fill.repeat(32 - suffix.length)}${suffix}` as EventId;
    },
  });
}

async function workspace(t: TestContext, label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `flashcoder-recovery-${label}-`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function usage(rawFinishReason: string): DeepSeekUsage {
  return Object.freeze({
    promptTokens: 12,
    promptCacheHitTokens: 2,
    promptCacheMissTokens: 10,
    completionTokens: 4,
    reasoningTokens: 1,
    rawFinishReason,
  });
}

function response(input: Readonly<{
  readonly content: string;
  readonly requestId: string;
  readonly toolCalls?: readonly ToolCall[];
}>): CompletedDeepSeekResponse {
  const toolCalls = Object.freeze([...(input.toolCalls ?? [])]);
  const assistantBytes = materializeAssistant({
    content: input.content,
    reasoningContent: "durable recovery fixture",
    toolCalls,
  });
  return Object.freeze({
    assistantBytes,
    content: input.content,
    reasoningContent: "durable recovery fixture",
    toolCalls,
    usage: usage(toolCalls.length === 0 ? "stop" : "tool_calls"),
    providerRequestId: input.requestId,
    responseModel: DEEPSEEK_MODEL,
    systemFingerprint: null,
    semanticDeltaCount: 1,
  });
}

function success(value: CompletedDeepSeekResponse) {
  return Object.freeze({
    kind: "success" as const,
    response: value,
    fragments: Object.freeze([
      value.toolCalls.length === 0
        ? Object.freeze({ kind: "content" as const, text: value.content })
        : Object.freeze({ kind: "tool_call" as const }),
    ]),
  });
}

function toolCall(
  id: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): ToolCall {
  return Object.freeze({
    id,
    type: "function" as const,
    function: Object.freeze({ name, arguments: JSON.stringify(args) }),
  });
}

async function replay(
  root: string,
  id: SessionId,
  fill: string,
): Promise<readonly AnyVerifiedJournalEvent[]> {
  const opened = await openJournal(root, id, fixedClock, eventIds(fill));
  try {
    return opened.writer.events;
  } finally {
    await opened.writer.close();
  }
}

function providerFreeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment["DEEPSEEK_API_KEY"];
  delete environment["DSH_LIVE"];
  return environment;
}

async function createLegacyV4Snapshot(input: Readonly<{
  readonly root: string;
  readonly id: SessionId;
  readonly additionalIds?: readonly SessionId[];
}>): Promise<void> {
  const baselineRoot = join(input.root, "legacy-v4-source");
  const archivePath = join(input.root, "legacy-v4.tar");
  await mkdir(baselineRoot);
  const archived = spawnSync(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${archivePath}`,
      LEGACY_V4_REVISION,
    ],
    {
      cwd: REPO_ROOT,
      env: providerFreeEnvironment(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  assert.equal(archived.status, 0, archived.stderr);
  const extracted = spawnSync(
    "tar",
    ["-xf", archivePath, "-C", baselineRoot],
    {
      cwd: REPO_ROOT,
      env: providerFreeEnvironment(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  assert.equal(extracted.status, 0, extracted.stderr);
  await symlink(join(REPO_ROOT, "node_modules"), join(baselineRoot, "node_modules"), "dir");
  const built = spawnSync("npm", ["run", "build", "--silent"], {
    cwd: baselineRoot,
    env: providerFreeEnvironment(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const moduleUrl = pathToFileURL(
    join(baselineRoot, "dist", "src", "session", "index.js"),
  ).href;
  const marker = "legacy-v4-snapshot-created";
  const childSource = `
import { runSessionFixture } from ${JSON.stringify(moduleUrl)};
let counter = 0;
const clock = Object.freeze({ now: () => ${JSON.stringify(FIXED_AT)} });
const eventIds = Object.freeze({
  nextEventId: () => {
    counter += 1;
    return "evt_" + "a".repeat(32 - counter.toString(16).length) + counter.toString(16);
  },
});
for (const fixtureSessionId of ${JSON.stringify([
    input.id,
    ...(input.additionalIds ?? []),
  ])}) {
  try {
    await runSessionFixture({
      workspaceRoot: ${JSON.stringify(input.root)},
      sessionId: fixtureSessionId,
      userInput: "Recover the frozen v4 edit ABI.",
      turns: [],
      clock,
      eventIds,
      onBeforeSend: () => { throw new Error(${JSON.stringify(marker)}); },
    });
    process.exitCode = 2;
    break;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ${JSON.stringify(marker)}) {
      process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 3;
      break;
    }
  }
}
`;
  const created = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", childSource],
    {
      cwd: baselineRoot,
      env: providerFreeEnvironment(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  assert.equal(created.status, 0, created.stderr || created.stdout);
}

test("crash before first attempt aliases the exact durable Snapshot in one recovery Run", async (t) => {
  const root = await workspace(t, "snapshot-alias");
  const id = sessionId("1");
  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Preserve the first request bytes.",
      turns: [],
      clock: fixedClock,
      eventIds: eventIds("1"),
      onBeforeSend: () => {
        throw new Error("simulated crash before send");
      },
    }),
    /simulated crash before send/u,
  );

  const completed = await recoverSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    turns: [success(response({ content: "recovered", requestId: "alias-1" }))],
    clock: fixedClock,
    eventIds: eventIds("2"),
  });
  assert.equal(completed.content, "recovered");

  const events = await replay(root, id, "3");
  const snapshots = events.filter(
    (event) => event.type === "request_snapshot_stored",
  );
  assert.equal(snapshots.length, 2);
  assert.equal(
    snapshots[1]?.payload.recoveryFromSnapshotId,
    snapshots[0]?.payload.requestSnapshotId,
  );
  assert.equal(snapshots[1]?.payload.bodyHash, snapshots[0]?.payload.bodyHash);
  assert.equal(snapshots[1]?.payload.bodyRef, snapshots[0]?.payload.bodyRef);
  assert.deepEqual(
    events.filter((event) => event.type === "run_started").map((event) => event.payload.cause),
    ["user", "recovery"],
  );
});

test("legacy v4/v1 recovery preserves its edit ABI and exact verbose completed result", async (t) => {
  const root = await workspace(t, "legacy-v4-profile");
  const id = sessionId("e");
  const completedGapId = sessionId("f");
  await createLegacyV4Snapshot({
    root,
    id,
    additionalIds: [completedGapId],
  });
  const target = join(root, "target.txt");
  const noMatchTarget = join(root, "no-match.txt");
  const notUniqueTarget = join(root, "not-unique.txt");
  await writeFile(target, "old", "utf8");
  await writeFile(noMatchTarget, "one two", "utf8");
  await writeFile(notUniqueTarget, "one two one", "utf8");
  const requestBodies: string[] = [];
  const invalidLegacyEdit = toolCall(
    "call_legacy_missing_replace_all",
    "edit",
    {
      path: "target.txt",
      old_string: "old",
      new_string: "new",
    },
  );
  const noMatchLegacyEdit = toolCall(
    "call_legacy_no_match",
    "edit",
    {
      path: "no-match.txt",
      old_string: "absent",
      new_string: "replacement",
      replace_all: false,
    },
  );
  const notUniqueLegacyEdit = toolCall(
    "call_legacy_not_unique",
    "edit",
    {
      path: "not-unique.txt",
      old_string: "one",
      new_string: "replacement",
      replace_all: false,
    },
  );
  const legacyCallIds = new Set([
    invalidLegacyEdit.id,
    noMatchLegacyEdit.id,
    notUniqueLegacyEdit.id,
  ]);
  const completed = await recoverSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    turns: [
      success(response({
        content: "",
        requestId: "legacy-edit-invalid",
        toolCalls: [
          invalidLegacyEdit,
          noMatchLegacyEdit,
          notUniqueLegacyEdit,
        ],
      })),
      success(response({
        content: "legacy ABI preserved",
        requestId: "legacy-edit-final",
      })),
    ],
    clock: fixedClock,
    eventIds: eventIds("b"),
    onBeforeSend: ({ snapshot }) => {
      requestBodies.push(new TextDecoder().decode(snapshot.body.copy()));
    },
  });
  assert.equal(completed.content, "legacy ABI preserved");
  assert.equal(await readFile(target, "utf8"), "old");
  assert.equal(await readFile(noMatchTarget, "utf8"), "one two");
  assert.equal(await readFile(notUniqueTarget, "utf8"), "one two one");
  assert.equal(requestBodies.length, 2);

  interface ProviderRequest {
    readonly messages: readonly Readonly<{
      readonly role: string;
      readonly content: string;
      readonly tool_call_id?: string;
    }>[];
    readonly tools: readonly Readonly<{
      readonly function: Readonly<{
        readonly name: string;
        readonly description: string;
        readonly parameters: Readonly<{ readonly required: readonly string[] }>;
      }>;
    }>[];
  }
  const secondRequest = JSON.parse(requestBodies[1] as string) as ProviderRequest;
  const editSchema = secondRequest.tools.find(
    (tool) => tool.function.name === "edit",
  );
  assert.ok(editSchema);
  assert.equal(editSchema.function.description, "Replace exact text in a file.");
  assert.deepEqual(editSchema.function.parameters.required, [
    "path",
    "old_string",
    "new_string",
    "replace_all",
  ]);
  const projectedContent = (callId: string): Record<string, unknown> => {
    const projected = secondRequest.messages.findLast(
      (message) =>
        message.role === "tool" && message.tool_call_id === callId,
    );
    assert.ok(projected);
    return JSON.parse(projected.content) as Record<string, unknown>;
  };
  assert.deepEqual(projectedContent(invalidLegacyEdit.id), {
    status: "invalid",
    code: "invalid_arguments",
  });
  for (const [callId, code] of [
    [noMatchLegacyEdit.id, "edit_no_match"],
    [notUniqueLegacyEdit.id, "edit_not_unique"],
  ] as const) {
    const content = projectedContent(callId);
    assert.deepEqual(
      {
        status: content["status"],
        code: content["code"],
        hasMatchCount: Object.hasOwn(content, "matchCount"),
        byteCount: content["byte_count"],
        payloadBytes: content["payload_bytes"],
        head: content["head"],
      },
      {
        status: "failed",
        code,
        hasMatchCount: false,
        byteCount: 0,
        payloadBytes: { read: 0, stdout: 0, stderr: 0 },
        head: "",
      },
    );
  }

  const events = await replay(root, id, "c");
  const assistant = events.find(
    (event): event is Extract<
      AnyVerifiedJournalEvent,
      { readonly type: "assistant_committed" }
    > =>
      event.type === "assistant_committed" &&
      event.payload.providerRequestId === "legacy-edit-invalid",
  );
  assert.ok(assistant);
  const results = events.filter(
    (event): event is Extract<
      AnyVerifiedJournalEvent,
      { readonly type: "tool_result_committed" }
    > =>
      event.type === "tool_result_committed" &&
      legacyCallIds.has(event.payload.toolCallId),
  );
  assert.equal(results.length, 3);
  const invalidResult = results.find(
    (event) => event.payload.toolCallId === invalidLegacyEdit.id,
  );
  assert.ok(invalidResult);
  assert.equal(invalidResult.payload.artifactId, null);
  assert.equal(invalidResult.payload.effectId, null);
  assert.equal(invalidResult.payload.sourceEventId, assistant.id);
  for (const callId of [noMatchLegacyEdit.id, notUniqueLegacyEdit.id]) {
    const result = results.find((event) => event.payload.toolCallId === callId);
    assert.ok(result);
    assert.notEqual(result.payload.artifactId, null);
    assert.equal(result.payload.effectId, null);
    const artifact = events.find(
      (event): event is Extract<
        AnyVerifiedJournalEvent,
        { readonly type: "artifact_published" }
      > =>
        event.type === "artifact_published" &&
        event.payload.toolCallId === callId,
    );
    assert.ok(artifact);
    assert.equal(artifact.payload.byteCount, 0);
    assert.deepEqual(artifact.payload.streamBytes, {
      read: 0,
      stdout: 0,
      stderr: 0,
    });
  }
  assert.equal(
    events.some(
      (event) =>
        (event.type === "effect_prepared" ||
          event.type === "effect_completed") &&
        legacyCallIds.has(event.payload.toolCallId),
    ),
    false,
  );
  assert.equal(
    events.some(
      (event) =>
        (event.type === "permission_decided" ||
          event.type === "artifact_published") &&
        event.payload.toolCallId === invalidLegacyEdit.id,
    ),
    false,
  );

  const completedGapCall = toolCall(
    "call_legacy_completed_without_result",
    "write",
    {
      path: "legacy-completed-gap.txt",
      content: "LEGACY_EFFECT_ONCE\n",
    },
  );
  let recoveryAppends = 0;
  await assert.rejects(
    recoverSessionFixture({
      workspaceRoot: root,
      sessionId: completedGapId,
      turns: [
        success(response({
          content: "",
          requestId: "legacy-completed-gap",
          toolCalls: [completedGapCall],
        })),
      ],
      clock: fixedClock,
      eventIds: eventIds("d"),
      persistenceControls: {
        fault: (point) => {
          if (point !== "append.after_sync_before_ack") return;
          recoveryAppends += 1;
          if (recoveryAppends === 11) {
            throw new Error("legacy effect-completed acknowledgement crash");
          }
        },
      },
    }),
    (error: unknown) =>
      error instanceof SessionKernelError && error.code === "durability_failure",
  );
  assert.equal(recoveryAppends, 11);
  const completedGapEvents = await replay(root, completedGapId, "e");
  const completedArtifact = completedGapEvents.find(
    (event): event is Extract<
      AnyVerifiedJournalEvent,
      { readonly type: "artifact_published" }
    > =>
      event.type === "artifact_published" &&
      event.payload.toolCallId === completedGapCall.id,
  );
  assert.ok(completedArtifact);
  assert.equal(
    completedGapEvents.filter(
      (event) =>
        event.type === "effect_completed" &&
        event.payload.toolCallId === completedGapCall.id,
    ).length,
    1,
  );
  assert.equal(
    completedGapEvents.filter(
      (event) =>
        event.type === "tool_result_committed" &&
        event.payload.toolCallId === completedGapCall.id,
    ).length,
    0,
  );

  let completedGapBody = "";
  await recoverSessionFixture({
    workspaceRoot: root,
    sessionId: completedGapId,
    turns: [
      success(response({
        content: "legacy completed gap recovered",
        requestId: "legacy-completed-gap-recovered",
      })),
    ],
    clock: fixedClock,
    eventIds: eventIds("f"),
    onBeforeSend: ({ snapshot }) => {
      completedGapBody = new TextDecoder().decode(snapshot.body.copy());
    },
  });
  const completedGapRequest = JSON.parse(completedGapBody) as ProviderRequest;
  const completedGapMessage = completedGapRequest.messages.findLast(
    (message) =>
      message.role === "tool" &&
      message.tool_call_id === completedGapCall.id,
  );
  assert.ok(completedGapMessage);
  assert.equal(
    completedGapMessage.content,
    JSON.stringify({
      status: "succeeded",
      code: "ok",
      artifact_id: completedArtifact.payload.artifactId,
      artifact_ref: completedArtifact.payload.artifactRef,
      artifact_sha256: completedArtifact.payload.artifactHash,
      byte_count: 0,
      payload_bytes: { read: 0, stdout: 0, stderr: 0 },
      framing_byte_count: 0,
      hard_limit_reached: false,
      exit_code: null,
      signal: null,
      encoding: "utf8",
      head: "",
      tail: "",
      truncated: false,
    }),
  );
  const recoveredGapEvents = await replay(root, completedGapId, "1");
  assert.equal(
    recoveredGapEvents.filter(
      (event) =>
        event.type === "tool_result_committed" &&
        event.payload.toolCallId === completedGapCall.id,
    ).length,
    1,
  );
});

test("unprojected Boundary fresh-projects once then a second crash transitions to alias", async (t) => {
  const root = await workspace(t, "fresh-then-alias");
  const id = sessionId("2");
  let publications = 0;
  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Exercise the never-projected recovery path.",
      turns: [],
      clock: fixedClock,
      eventIds: eventIds("4"),
      persistenceControls: {
        fault: (point) => {
          if (point !== "cas.after_temp_sync") return;
          publications += 1;
          if (publications === 3) throw new Error("snapshot CAS stop");
        },
      },
    }),
    (error: unknown) =>
      error instanceof SessionInterruptedError &&
      error.reason === "durability_failure",
  );

  await assert.rejects(
    recoverSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      turns: [],
      clock: fixedClock,
      eventIds: eventIds("5"),
      onBeforeSend: () => {
        throw new Error("second crash after fresh projection");
      },
    }),
    /second crash after fresh projection/u,
  );

  await recoverSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    turns: [success(response({ content: "done", requestId: "fresh-alias" }))],
    clock: fixedClock,
    eventIds: eventIds("6"),
  });
  const events = await replay(root, id, "7");
  const snapshots = events.filter(
    (event) => event.type === "request_snapshot_stored",
  );
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0]?.payload.recoveryFromSnapshotId, null);
  assert.equal(
    snapshots[1]?.payload.recoveryFromSnapshotId,
    snapshots[0]?.payload.requestSnapshotId,
  );
  assert.equal(snapshots[1]?.payload.bodyHash, snapshots[0]?.payload.bodyHash);
  assert.equal(
    events.filter((event) => event.type === "run_started").length,
    3,
  );
});

for (const [targetAppend, expectedSemantic] of [
  [12, "semantic_state_unknown"],
  [13, "post_semantic"],
] as const) {
  test(`open request at append ${String(targetAppend)} closes as ${expectedSemantic} before alias`, async (t) => {
    const root = await workspace(t, `open-request-${String(targetAppend)}`);
    const id = sessionId(targetAppend === 12 ? "3" : "4");
    let appends = 0;
    await assert.rejects(
      runSessionFixture({
        workspaceRoot: root,
        sessionId: id,
        userInput: "Crash the open physical request.",
        turns: [success(response({ content: "unused", requestId: "unused" }))],
        clock: fixedClock,
        eventIds: eventIds(targetAppend === 12 ? "8" : "9"),
        persistenceControls: {
          fault: (point) => {
            if (point !== "append.after_sync_before_ack") return;
            appends += 1;
            if (appends === targetAppend) throw new Error("request crash");
          },
        },
      }),
      (error: unknown) =>
        error instanceof SessionKernelError && error.code === "durability_failure",
    );
    await recoverSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      turns: [success(response({ content: "closed", requestId: "closed" }))],
      clock: fixedClock,
      eventIds: eventIds(targetAppend === 12 ? "a" : "b"),
    });
    const events = await replay(root, id, targetAppend === 12 ? "c" : "d");
    const interrupted = events.find(
      (event) => event.type === "request_interrupted",
    );
    assert.ok(interrupted);
    assert.equal(interrupted.payload.outcome, "durability_error");
    assert.equal(interrupted.payload.retryClass, "unknown");
    assert.equal(interrupted.payload.semanticState, expectedSemantic);
    assert.equal(
      events.filter((event) => event.type === "request_interrupted").length,
      1,
    );
  });
}

test("v2 recovery reconstructs one compact T1 result then replays its durable bytes", async (t) => {
  const root = await workspace(t, "t1-artifact");
  const id = sessionId("5");
  const path = join(root, "input.txt");
  const original = "ORIGINAL_DURABLE_T1_BYTES\n";
  const changed = "CHANGED_AFTER_CRASH\n";
  await writeFile(path, original, "utf8");
  const read = toolCall("call_recovery_read", "read", { path });
  let appends = 0;
  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Read the fixture exactly once.",
      turns: [success(response({ content: "", requestId: "read-1", toolCalls: [read] }))],
      clock: fixedClock,
      eventIds: eventIds("e"),
      persistenceControls: {
        fault: (point) => {
          if (point !== "append.after_sync_before_ack") return;
          appends += 1;
          if (appends === 17) throw new Error("crash after T1 Artifact");
        },
      },
    }),
    (error: unknown) =>
      error instanceof SessionKernelError && error.code === "durability_failure",
  );
  await writeFile(path, changed, "utf8");
  const recoveryBodies: string[] = [];
  await assert.rejects(
    recoverSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      turns: [],
      clock: fixedClock,
      eventIds: eventIds("f"),
      onBeforeSend: ({ snapshot }) => {
        recoveryBodies.push(new TextDecoder().decode(snapshot.body.copy()));
      },
    }),
    (error: unknown) =>
      error instanceof SessionInterruptedError &&
      error.reason === "durability_failure",
  );
  await recoverSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    turns: [success(response({ content: "read recovered", requestId: "read-2" }))],
    clock: fixedClock,
    eventIds: eventIds("1"),
    onBeforeSend: ({ snapshot }) => {
      recoveryBodies.push(new TextDecoder().decode(snapshot.body.copy()));
    },
  });
  assert.equal(recoveryBodies.length, 2);
  assert.equal(recoveryBodies[1], recoveryBodies[0]);
  assert.match(recoveryBodies[0] as string, /ORIGINAL_DURABLE_T1_BYTES/u);
  assert.doesNotMatch(recoveryBodies[0] as string, /CHANGED_AFTER_CRASH/u);
  interface ProviderRequest {
    readonly messages: readonly Readonly<{
      readonly role: string;
      readonly content: string;
      readonly tool_call_id?: string;
    }>[];
  }
  const recoveryRequest = JSON.parse(
    recoveryBodies[0] as string,
  ) as ProviderRequest;
  const recoveredToolMessage = recoveryRequest.messages.findLast(
    (message) =>
      message.role === "tool" && message.tool_call_id === read.id,
  );
  assert.ok(recoveredToolMessage);
  assert.equal(
    recoveredToolMessage.content,
    JSON.stringify({
      status: "succeeded",
      code: "ok",
      hard_limit_reached: false,
      exit_code: null,
      signal: null,
      encoding: "utf8",
      head: `1\t${original}`,
      tail: "",
      truncated: false,
    }),
  );
  assert.equal(await readFile(path, "utf8"), changed);
  const events = await replay(root, id, "2");
  assert.equal(
    events.filter(
      (event) =>
        event.type === "artifact_published" &&
        event.payload.toolCallId === "call_recovery_read",
    ).length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "tool_result_committed" &&
        event.payload.toolCallId === "call_recovery_read",
    ).length,
    1,
  );
  const snapshots = events.filter(
    (event) => event.type === "request_snapshot_stored",
  );
  const projected = snapshots.at(-2);
  const alias = snapshots.at(-1);
  assert.ok(projected);
  assert.ok(alias);
  assert.equal(alias.payload.bodyHash, projected.payload.bodyHash);
  assert.equal(alias.payload.bodyRef, projected.payload.bodyRef);
  assert.equal(
    alias.payload.recoveryFromSnapshotId,
    projected.payload.requestSnapshotId,
  );
});

test("durable edit match Artifact reconstructs its original count without rechecking the file", async (t) => {
  const root = await workspace(t, "edit-match-artifact");
  const id = sessionId("d");
  const path = join(root, "edit.txt");
  await writeFile(path, "one two one", "utf8");
  const edit = toolCall("call_recovery_edit_match", "edit", {
    path,
    old_string: "one",
    new_string: "replacement",
  });
  let appends = 0;
  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Attempt the exact edit once.",
      turns: [
        success(response({
          content: "",
          requestId: "edit-match-1",
          toolCalls: [edit],
        })),
      ],
      clock: fixedClock,
      eventIds: eventIds("6"),
      persistenceControls: {
        fault: (point) => {
          if (point !== "append.after_sync_before_ack") return;
          appends += 1;
          if (appends === 17) throw new Error("crash after edit match Artifact");
        },
      },
    }),
    (error: unknown) =>
      error instanceof SessionKernelError && error.code === "durability_failure",
  );

  await writeFile(path, "one only", "utf8");
  let recoveryBody = "";
  await recoverSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    turns: [
      success(response({ content: "edit recovered", requestId: "edit-match-2" })),
    ],
    clock: fixedClock,
    eventIds: eventIds("7"),
    onBeforeSend: ({ snapshot }) => {
      recoveryBody = new TextDecoder().decode(snapshot.body.copy());
    },
  });
  assert.equal(recoveryBody.includes('\\"matchCount\\":2'), true);
  assert.equal(await readFile(path, "utf8"), "one only");
  const events = await replay(root, id, "8");
  assert.equal(
    events.filter(
      (event) =>
        event.type === "artifact_published" &&
        event.payload.toolCallId === "call_recovery_edit_match",
    ).length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "tool_result_committed" &&
        event.payload.toolCallId === "call_recovery_edit_match",
    ).length,
    1,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "effect_prepared" &&
        event.payload.toolCallId === "call_recovery_edit_match",
    ),
    false,
  );
});

test("durable completed write reconstructs its result and never repeats the effect", async (t) => {
  const root = await workspace(t, "completed-effect");
  const id = sessionId("6");
  const path = join(root, "effect.txt");
  const write = toolCall("call_recovery_write", "write", {
    path,
    content: "FIRST_EFFECT_VALUE\n",
  });
  let appends = 0;
  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Write once.",
      turns: [success(response({ content: "", requestId: "write-1", toolCalls: [write] }))],
      clock: fixedClock,
      eventIds: eventIds("2"),
      persistenceControls: {
        fault: (point) => {
          if (point !== "append.after_sync_before_ack") return;
          appends += 1;
          if (appends === 19) throw new Error("crash after effect completion");
        },
      },
    }),
    (error: unknown) =>
      error instanceof SessionKernelError && error.code === "durability_failure",
  );
  await writeFile(path, "OPERATOR_CHANGED_VALUE\n", "utf8");
  await recoverSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    turns: [success(response({ content: "effect recovered", requestId: "write-2" }))],
    clock: fixedClock,
    eventIds: eventIds("3"),
  });
  assert.equal(await readFile(path, "utf8"), "OPERATOR_CHANGED_VALUE\n");
  const events = await replay(root, id, "4");
  assert.equal(
    events.filter(
      (event) =>
        event.type === "effect_prepared" &&
        event.payload.toolCallId === "call_recovery_write",
    ).length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "tool_result_committed" &&
        event.payload.toolCallId === "call_recovery_write",
    ).length,
    1,
  );
});

test("durable prepared effect becomes crash-gap indeterminate and is never executed", async (t) => {
  const root = await workspace(t, "prepared-effect");
  const id = sessionId("7");
  const path = join(root, "must-not-exist.txt");
  const write = toolCall("call_prepared_write", "write", {
    path,
    content: "must not be written",
  });
  let appends = 0;
  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Stop at prepared.",
      turns: [success(response({ content: "", requestId: "prepared", toolCalls: [write] }))],
      clock: fixedClock,
      eventIds: eventIds("5"),
      persistenceControls: {
        fault: (point) => {
          if (point !== "append.after_sync_before_ack") return;
          appends += 1;
          if (appends === 17) throw new Error("crash after effect prepared");
        },
      },
    }),
    (error: unknown) =>
      error instanceof SessionKernelError && error.code === "durability_failure",
  );
  await assert.rejects(
    recoverSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      turns: [],
      clock: fixedClock,
      eventIds: eventIds("6"),
    }),
    (error: unknown) =>
      error instanceof SessionInterruptedError &&
      error.reason === "effect_indeterminate",
  );
  await assert.rejects(readFile(path), { code: "ENOENT" });
  const events = await replay(root, id, "7");
  assert.equal(
    events.filter((event) => event.type === "effect_indeterminate").length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "run_interrupted" &&
        event.payload.reason === "effect_indeterminate",
    ).length,
    1,
  );
  assert.deepEqual(
    events.filter((event) => event.type === "run_started").map((event) => event.payload.cause),
    ["user", "recovery"],
  );
});

test("pending T2 after durable Checkpoint executes exactly once in the successor Run", async (t) => {
  const root = await workspace(t, "pending-t2");
  const id = sessionId("8");
  const path = join(root, "pending-write.txt");
  const write = toolCall("call_pending_write", "write", {
    path,
    content: "ONE_RECOVERY_EFFECT\n",
  });
  let appends = 0;
  await assert.rejects(
    runSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      userInput: "Resume after the durable tool Checkpoint.",
      turns: [success(response({ content: "", requestId: "pending-1", toolCalls: [write] }))],
      clock: fixedClock,
      eventIds: eventIds("8"),
      persistenceControls: {
        fault: (point) => {
          if (point !== "append.after_sync_before_ack") return;
          appends += 1;
          if (appends === 15) throw new Error("checkpoint acknowledgement crash");
        },
      },
    }),
    (error: unknown) =>
      error instanceof SessionKernelError && error.code === "durability_failure",
  );
  await recoverSessionFixture({
    workspaceRoot: root,
    sessionId: id,
    turns: [success(response({ content: "pending recovered", requestId: "pending-2" }))],
    clock: fixedClock,
    eventIds: eventIds("9"),
  });
  assert.equal(await readFile(path, "utf8"), "ONE_RECOVERY_EFFECT\n");
  const events = await replay(root, id, "a");
  assert.equal(
    events.filter(
      (event) =>
        event.type === "effect_prepared" &&
        event.payload.toolCallId === "call_pending_write",
    ).length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "tool_result_committed" &&
        event.payload.toolCallId === "call_pending_write",
    ).length,
    1,
  );
  assert.deepEqual(
    events.filter((event) => event.type === "run_started").map((event) => event.payload.cause),
    ["user", "recovery"],
  );
});

for (const targetAppend of [14, 15, 16, 17] as const) {
  test(`finalization seam ${String(targetAppend)} converges in the original Run without a model resend`, async (t) => {
    const root = await workspace(t, `finalize-${String(targetAppend)}`);
    const id = sessionId(targetAppend === 14 ? "9" : targetAppend === 15 ? "a" : targetAppend === 16 ? "b" : "c");
    let appends = 0;
    const final = response({
      content: `final-${String(targetAppend)}`,
      requestId: `final-${String(targetAppend)}`,
    });
    await assert.rejects(
      runSessionFixture({
        workspaceRoot: root,
        sessionId: id,
        userInput: "Complete deterministic finalization.",
        turns: [success(final)],
        clock: fixedClock,
        eventIds: eventIds(targetAppend === 14 ? "b" : targetAppend === 15 ? "c" : targetAppend === 16 ? "d" : "e"),
        persistenceControls: {
          fault: (point) => {
            if (point !== "append.after_sync_before_ack") return;
            appends += 1;
            if (appends === targetAppend) throw new Error("finalization acknowledgement crash");
          },
        },
      }),
      (error: unknown) =>
        error instanceof SessionKernelError && error.code === "durability_failure",
    );
    let sends = 0;
    const completed = await recoverSessionFixture({
      workspaceRoot: root,
      sessionId: id,
      turns: [],
      clock: fixedClock,
      eventIds: eventIds(targetAppend === 14 ? "1" : targetAppend === 15 ? "2" : targetAppend === 16 ? "3" : "4"),
      onBeforeSend: () => {
        sends += 1;
      },
    });
    assert.equal(completed.content, final.content);
    assert.equal(sends, 0);
    const events = await replay(root, id, "5");
    assert.equal(events.filter((event) => event.type === "run_started").length, 1);
    assert.equal(events.filter((event) => event.type === "assistant_committed").length, 1);
    assert.equal(events.filter((event) => event.type === "cache_checkpoint_created").length, 1);
    assert.equal(events.filter((event) => event.type === "run_completed").length, 1);
    assert.equal(events.filter((event) => event.type === "run_interrupted").length, 0);
  });
}
