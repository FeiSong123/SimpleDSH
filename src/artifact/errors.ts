export type ArtifactStoreErrorCode =
  | "artifact_closed_metadata"
  | "artifact_integrity"
  | "artifact_io"
  | "artifact_range"
  | "artifact_state"
  | "cas_collision";

export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode;

  constructor(code: ArtifactStoreErrorCode, message: string) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}
