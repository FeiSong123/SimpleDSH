import { join, resolve } from "node:path";

import { createBlobStore } from "../../src/blob/store.js";
import type { ToolCall } from "../../src/ds/types.js";
import { openJournal } from "../../src/journal/open.js";
import type {
  CanonicalTimestamp,
  EventId,
  SessionId,
} from "../../src/journal/types.js";
import { JournalToolDurability } from "../../src/tool/durability.js";
import type { FileMutationFaultPoint } from "../../src/tool/file.js";
import { ToolRuntime } from "../../src/tool/runtime.js";

type CrashMode =
  | "before_prepared"
  | "prepared_before_publish"
  | "published_before_completed"
  | "completed";

const MODES = new Set<CrashMode>([
  "before_prepared",
  "prepared_before_publish",
  "published_before_completed",
  "completed",
]);

function isCrashMode(value: string | undefined): value is CrashMode {
  return value !== undefined && MODES.has(value as CrashMode);
}

function eventIds(): { readonly nextEventId: () => EventId } {
  let counter = 0;
  return {
    nextEventId: () => {
      counter += 1;
      return `evt_${counter.toString(16).padStart(32, "c")}` as EventId;
    },
  };
}

async function crash(): Promise<never> {
  process.kill(process.pid, "SIGKILL");
  return new Promise<never>(() => undefined);
}

const [workspaceRoot, sessionIdValue, modeValue, repositoryRootValue] =
  process.argv.slice(2);

if (
  workspaceRoot === undefined ||
  sessionIdValue === undefined ||
  !isCrashMode(modeValue) ||
  repositoryRootValue === undefined
) {
  process.exitCode = 2;
} else {
  const opened = await openJournal(
    workspaceRoot,
    sessionIdValue as SessionId,
    {
      now: () => "2026-08-04T06:00:00.000Z" as CanonicalTimestamp,
    },
    eventIds(),
  );
  const assistant = opened.replay.events.findLast(
    (event) => event.type === "assistant_committed",
  );
  if (
    assistant?.type !== "assistant_committed" ||
    assistant.lineageId === undefined ||
    assistant.runId === undefined
  ) {
    process.exitCode = 3;
  } else {
    const blobs = await createBlobStore(opened.paths.sessionDir);
    const durability = new JournalToolDurability({
      scope: {
        sessionId: sessionIdValue as SessionId,
        lineageId: assistant.lineageId,
        runId: assistant.runId,
        sourceAssistantEventId: assistant.id,
      },
      writer: opened.writer,
      artifacts: opened.artifacts,
      blobs,
      blobPosition: {
        blobIndex: assistant.payload.blobIndex + 1,
        previousChainHash: assistant.payload.chainHash,
      },
    });
    const repositoryRoot = resolve(repositoryRootValue);
    const crashPoint: FileMutationFaultPoint | undefined =
      modeValue === "prepared_before_publish"
        ? "before_publish"
        : modeValue === "published_before_completed"
          ? "after_parent_sync"
          : undefined;
    const runtime = new ToolRuntime({
      durability,
      cwd: workspaceRoot,
      storageRoot: opened.paths.storageDir,
      canonicalEnvPath: join(repositoryRoot, ".env"),
      umask: 0o022,
      toolsProfile: "edit-v5",
      resultProfile: "verbose-v1",
      ...(crashPoint === undefined
        ? {}
        : {
            fileMutationControls: {
              tempNameHex: () => "f".repeat(32),
              reach: async (point: FileMutationFaultPoint) => {
                if (point === crashPoint) await crash();
              },
            },
          }),
    });
    const calls: readonly ToolCall[] = Object.freeze([
      Object.freeze({
        id: "call_crash_write",
        type: "function" as const,
        function: Object.freeze({
          name: "write",
          arguments: JSON.stringify({
            path: "crash-target.txt",
            content: "once\n",
          }),
        }),
      }),
    ]);

    if (modeValue === "before_prepared") await crash();
    await runtime.execute(calls, new AbortController().signal);
    if (modeValue === "completed") await crash();
    process.exitCode = 4;
  }
}
