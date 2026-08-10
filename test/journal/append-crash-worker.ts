import { openJournal } from "../../src/journal/open.js";
import type { PersistenceFaultPoint } from "../../src/journal/faults.js";
import type {
  CanonicalTimestamp,
  EventId,
  SessionId,
} from "../../src/journal/types.js";

const [workspaceRoot, sessionIdValue, faultPointValue] = process.argv.slice(2);
if (
  workspaceRoot === undefined ||
  sessionIdValue === undefined ||
  faultPointValue === undefined
) {
  process.exitCode = 2;
} else {
  const faultPoint = faultPointValue as PersistenceFaultPoint;
  const opened = await openJournal(
    workspaceRoot,
    sessionIdValue as SessionId,
    {
      now: () => "2026-08-03T04:00:00.000Z" as CanonicalTimestamp,
    },
    {
      nextEventId: () => `evt_${"d".repeat(32)}` as EventId,
    },
    {
      maxWriteBytes: 7,
      fault: (point) => {
        if (point === faultPoint) process.kill(process.pid, "SIGKILL");
      },
    },
  );
  await opened.writer.append({
    type: "integrity_violation",
    sessionId: sessionIdValue as SessionId,
    payload: {
      code: "derived_conflict",
      relatedEventId: null,
      expectedHash: null,
      actualHash: null,
    },
  });
  process.exitCode = 3;
}
