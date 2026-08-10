import { openJournal } from "../../src/journal/open.js";
import type {
  CanonicalTimestamp,
  EventId,
  SessionId,
} from "../../src/journal/types.js";
import type { PersistenceFaultPoint } from "../../src/journal/faults.js";

const [workspaceRoot, sessionIdValue, faultPointValue] = process.argv.slice(2);
if (
  workspaceRoot === undefined ||
  sessionIdValue === undefined ||
  faultPointValue === undefined
) {
  process.exitCode = 2;
} else {
  const faultPoint = faultPointValue as PersistenceFaultPoint;
  await openJournal(
    workspaceRoot,
    sessionIdValue as SessionId,
    {
      now: () => "2026-08-03T01:00:00.000Z" as CanonicalTimestamp,
    },
    {
      nextEventId: () => `evt_${"a".repeat(32)}` as EventId,
    },
    {
      maxWriteBytes: 13,
      fault: (point) => {
        if (point === faultPoint) process.kill(process.pid, "SIGKILL");
      },
    },
  );
  process.exitCode = 3;
}
