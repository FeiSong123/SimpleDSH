export type PersistenceFaultPoint =
  | "bootstrap.after_directory_sync_before_parent_sync"
  | "bootstrap.after_log_sync_before_session_sync"
  | "bootstrap.after_session_sync"
  | "lease.after_mkdir"
  | "lease.after_owner_sync"
  | "append.after_write_chunk"
  | "append.before_sync"
  | "append.after_sync_before_ack"
  | "cas.after_temp_sync"
  | "cas.after_link_before_dir_sync"
  | "cas.after_dir_sync_before_cleanup"
  | "repair.after_recovery_publish"
  | "repair.after_temp_prefix"
  | "repair.after_temp_event"
  | "repair.after_temp_sync"
  | "repair.after_rename_before_dir_sync"
  | "repair.after_dir_sync";

export interface PersistenceTestControls {
  readonly fault?: (
    point: PersistenceFaultPoint,
  ) => void | Promise<void>;
  readonly maxWriteBytes?: number;
}

export async function reachFaultPoint(
  controls: PersistenceTestControls | undefined,
  point: PersistenceFaultPoint,
): Promise<void> {
  await controls?.fault?.(point);
}

export function writeChunkLimit(
  controls: PersistenceTestControls | undefined,
  remaining: number,
): number {
  const configured = controls?.maxWriteBytes;
  if (configured === undefined) return remaining;
  if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new RangeError("maxWriteBytes must be a positive safe integer");
  }
  return Math.min(configured, remaining);
}
