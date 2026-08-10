import type { FrozenBytes } from "../bytes/types.js";
import type { ToolCallId } from "../bytes/tool-call-id.js";
import type { ToolTerminal } from "./terminal.js";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type Sha256 = Brand<string, "Sha256">;
export type ArtifactRef = Brand<
  `artifacts/sha256/${string}`,
  "ArtifactRef"
>;
export type BlobRef = Brand<`blobs/sha256/${string}`, "BlobRef">;
export type SnapshotRef = Brand<
  `snapshots/sha256/${string}`,
  "SnapshotRef"
>;
export type RecoveryRef = Brand<
  `recovery/sha256/${string}`,
  "RecoveryRef"
>;

export type CasRef = ArtifactRef | BlobRef | SnapshotRef | RecoveryRef;

export type ArtifactType =
  | "cache_abi_manifest"
  | "project_instructions"
  | "fact"
  | "tool_output"
  | "operator_evidence"
  | "user_state";

export interface ArtifactStreamBytes {
  readonly read: number;
  readonly stdout: number;
  readonly stderr: number;
}

export interface ArtifactMetadata {
  readonly lineCount: number | null;
  readonly mediaType: string;
  readonly artifactType: ArtifactType;
  readonly streamBytes: ArtifactStreamBytes | null;
  readonly hardLimitReached: boolean | null;
  readonly descendantsReaped: boolean | null;
  readonly toolCallId: ToolCallId | null;
  readonly terminal: ToolTerminal | null;
}

export interface ArtifactDescriptor extends ArtifactMetadata {
  readonly artifactRef: ArtifactRef;
  readonly artifactHash: Sha256;
  readonly byteCount: number;
}

export interface ArtifactRangeOptions {
  readonly offset: number;
  readonly maxBytes: number;
}

export interface ArtifactRange {
  readonly bytes: FrozenBytes;
  readonly offset: number;
  readonly byteCount: number;
  readonly totalByteCount: number;
  readonly eof: boolean;
}

export type ArtifactChunkVisitor = (
  bytes: FrozenBytes,
) => void | Promise<void>;

export interface ArtifactSink {
  write(bytes: Uint8Array | FrozenBytes): Promise<void>;
  publish(metadata: ArtifactMetadata): Promise<ArtifactDescriptor>;
  abort(): Promise<void>;
}

export interface ArtifactStore {
  beginArtifact(): Promise<ArtifactSink>;
  publishArtifact(
    bytes: Uint8Array | FrozenBytes,
    metadata: ArtifactMetadata,
  ): Promise<ArtifactDescriptor>;
  readArtifactRange(
    ref: ArtifactRef,
    options: ArtifactRangeOptions,
  ): Promise<ArtifactRange>;
  scanArtifact(
    descriptor: ArtifactDescriptor,
    visit: ArtifactChunkVisitor,
  ): Promise<void>;
  verifyArtifact(descriptor: ArtifactDescriptor): Promise<void>;
}
