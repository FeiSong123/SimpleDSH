import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";

import {
  bytesEqual,
  concatBytes,
  lengthPrefix,
  sha256Hex,
  toBase64,
  utf8Bytes,
} from "../../src/bytes/ops.js";
import {
  buildDeepSeekRequestSnapshot,
  buildDeepSeekRequestSnapshotWithTools,
} from "../../src/bytes/request.js";
import {
  CANONICAL_TOOLS_BYTES,
  LEGACY_CANONICAL_TOOLS_BYTES,
} from "../../src/bytes/schemas.js";
import { PREVIOUS_SYSTEM_MESSAGE_BYTES } from "../../src/bytes/system.js";
import { freezeBytes } from "../../src/bytes/types.js";
import { materializeUserMessage } from "../../src/bytes/user.js";
import { utf8View } from "../../src/bytes/view.js";
import { projectV1, type ProjectV1Input } from "../../src/ctx/projector.js";
import { createVerifiedJournalEvent } from "../../src/journal/schema.js";
import type {
  AnyJournalEventDraft,
  AnyVerifiedJournalEvent,
  ArtifactId,
  ArtifactRef,
  BlobRef,
  CacheAbiId,
  CanonicalTimestamp,
  CommitBoundaryId,
  EventId,
  LineageId,
  RunId,
  SessionId,
  Sha256,
} from "../../src/journal/types.js";
import {
  buildCacheAbiV1,
  loadCacheAbiV1,
  MODEL_TUPLE_BYTES,
  PROJECTOR_VERSION_V1,
  PROTOCOL_VERSION_V1,
  type FrozenCacheAbiManifest,
} from "../../src/lineage/cache-abi.js";

const SESSION_ID = `ses_${"1".repeat(32)}` as SessionId;
const LINEAGE_ID = `lin_${"2".repeat(32)}` as LineageId;
const RUN_ID = `run_${"3".repeat(32)}` as RunId;
const MANIFEST_ARTIFACT_ID = `art_${"4".repeat(32)}` as ArtifactId;
const FACT_ARTIFACT_ID = `art_${"5".repeat(32)}` as ArtifactId;
const BOUNDARY_ID = `cbd_${"6".repeat(32)}` as CommitBoundaryId;
const TIMESTAMP = "2026-08-04T00:00:00.000Z" as CanonicalTimestamp;

interface Fixture {
  readonly cacheAbi: FrozenCacheAbiManifest;
  readonly events: readonly AnyVerifiedJournalEvent[];
  readonly userBlob: ReturnType<typeof materializeUserMessage>;
  readonly boundaryEventId: EventId;
}

function artifactRef(hash: Sha256): ArtifactRef {
  return `artifacts/sha256/${hash.slice("sha256:".length)}` as ArtifactRef;
}

function fixture(cacheAbi: FrozenCacheAbiManifest = buildCacheAbiV1()): Fixture {
  const events: AnyVerifiedJournalEvent[] = [];
  const append = (draft: AnyJournalEventDraft): AnyVerifiedJournalEvent => {
    const previous = events.at(-1);
    const event = createVerifiedJournalEvent(draft, {
      seq: events.length + 1,
      id: `evt_${(events.length + 1).toString(16).padStart(32, "0")}` as EventId,
      at: TIMESTAMP,
      prevHash: previous?.hash ?? null,
    });
    events.push(event);
    return event;
  };

  append({ type: "session_started", sessionId: SESSION_ID, payload: {} });
  const manifestHash = cacheAbi.cacheAbiId as unknown as Sha256;
  const manifest = append({
    type: "artifact_published",
    sessionId: SESSION_ID,
    payload: {
      artifactId: MANIFEST_ARTIFACT_ID,
      artifactRef: artifactRef(manifestHash),
      artifactHash: manifestHash,
      byteCount: cacheAbi.manifestBytes.byteLength,
      lineCount: null,
      mediaType: "application/octet-stream",
      artifactType: "cache_abi_manifest",
      streamBytes: null,
      hardLimitReached: null,
      descendantsReaped: null,
      toolCallId: null,
      terminal: null,
    },
  });
  append({
    type: "cache_abi_declared",
    sessionId: SESSION_ID,
    parentId: manifest.id,
    payload: {
      cacheAbiId: cacheAbi.cacheAbiId,
      manifestArtifactId: MANIFEST_ARTIFACT_ID,
      manifestByteCount: cacheAbi.manifestBytes.byteLength,
    },
  });
  append({
    type: "lineage_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    payload: { cacheAbiId: cacheAbi.cacheAbiId },
  });
  append({
    type: "lineage_activated",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    payload: {
      previousLineageId: null,
      nextLineageId: LINEAGE_ID,
      reason: "initial",
    },
  });
  append({
    type: "run_started",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: { cause: "user", previousRunId: null },
  });

  const userInput = utf8Bytes("project the exact committed bytes");
  const factHash = `sha256:${sha256Hex(userInput)}` as Sha256;
  append({
    type: "artifact_published",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      artifactId: FACT_ARTIFACT_ID,
      artifactRef: artifactRef(factHash),
      artifactHash: factHash,
      byteCount: userInput.byteLength,
      lineCount: 1,
      mediaType: "text/plain",
      artifactType: "fact",
      streamBytes: null,
      hardLimitReached: null,
      descendantsReaped: null,
      toolCallId: null,
      terminal: null,
    },
  });
  const fact = append({
    type: "fact_recorded",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    payload: {
      kind: "user_input",
      artifactId: FACT_ARTIFACT_ID,
      byteCount: userInput.byteLength,
    },
  });

  const userBlob = materializeUserMessage("project the exact committed bytes");
  const byteHash = `sha256:${sha256Hex(userBlob)}` as Sha256;
  const user = append({
    type: "user_committed",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: fact.id,
    payload: {
      role: "user",
      enc: "b64",
      bytes: toBase64(userBlob),
      byteCount: userBlob.byteLength,
      byteHash,
      blobIndex: 0,
      chainHash: byteHash,
      sourceFactEventIds: [fact.id],
    },
  });
  const boundary = append({
    type: "commit_boundary_created",
    sessionId: SESSION_ID,
    lineageId: LINEAGE_ID,
    runId: RUN_ID,
    parentId: user.id,
    payload: {
      commitBoundaryId: BOUNDARY_ID,
      cacheCheckpointId: null,
      blobCount: 1,
      chainHash: byteHash,
      protocolClosed: true,
      effectsSettled: true,
      sourceEventIds: [user.id],
    },
  });

  return Object.freeze({
    cacheAbi,
    events: Object.freeze(events),
    userBlob,
    boundaryEventId: boundary.id,
  });
}

function legacyV4CacheAbi(): FrozenCacheAbiManifest {
  const manifest = concatBytes([
    utf8Bytes("dsh-cache-abi-v1\0"),
    lengthPrefix(utf8Bytes(PROTOCOL_VERSION_V1)),
    lengthPrefix(utf8Bytes(PROJECTOR_VERSION_V1)),
    lengthPrefix(MODEL_TUPLE_BYTES),
    lengthPrefix(PREVIOUS_SYSTEM_MESSAGE_BYTES),
    lengthPrefix(LEGACY_CANONICAL_TOOLS_BYTES),
  ]);
  return loadCacheAbiV1(
    manifest,
    `sha256:${sha256Hex(manifest)}` as CacheAbiId,
  );
}

function projectorInput(value: Fixture): ProjectV1Input {
  return Object.freeze({
    cacheAbi: value.cacheAbi,
    journalFacts: value.events,
    externalBlobs: new Map(),
    lineageId: LINEAGE_ID,
    commitBoundaryId: BOUNDARY_ID,
  });
}

const PROJECTOR_PRODUCTION_CLOSURE = Object.freeze([
  "src/artifact/terminal.ts",
  "src/artifact/tool-terminal-source.ts",
  "src/blob/prefix.ts",
  "src/bytes/assistant.ts",
  "src/bytes/ops.ts",
  "src/bytes/request.ts",
  "src/bytes/schemas.ts",
  "src/bytes/system.ts",
  "src/bytes/tool-arguments.ts",
  "src/bytes/tool-call-id.ts",
  "src/bytes/tool-result.ts",
  "src/bytes/tool.ts",
  "src/bytes/types.ts",
  "src/bytes/user.ts",
  "src/bytes/view.ts",
  "src/ctx/projector.ts",
  "src/ds/types.ts",
  "src/journal/closure.ts",
  "src/journal/errors.ts",
  "src/journal/schema.ts",
  "src/journal/types.ts",
  "src/lineage/cache-abi.ts",
  "src/lineage/prefix.ts",
] as const);

function projectorProductionClosure(): {
  readonly files: readonly string[];
  readonly ambientImports: readonly string[];
} {
  const root = resolve(".");
  const pending = [resolve("src/ctx/projector.ts")];
  const visited = new Set<string>();
  const ambientImports = new Set<string>();
  const importPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/gu;

  while (pending.length > 0) {
    const file = pending.shift();
    assert.notEqual(file, undefined);
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\bimport\s*\(/u, file);
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      assert.notEqual(specifier, undefined);
      if (specifier === undefined) continue;
      if (!specifier.startsWith(".")) {
        ambientImports.add(specifier);
        continue;
      }
      const target = resolve(
        dirname(file),
        specifier.endsWith(".js")
          ? `${specifier.slice(0, -".js".length)}.ts`
          : specifier,
      );
      assert.equal(relative(root, target).startsWith(".."), false, target);
      pending.push(target);
    }
  }

  return Object.freeze({
    files: Object.freeze(
      [...visited].map((file) => relative(root, file)).sort(),
    ),
    ambientImports: Object.freeze([...ambientImports].sort()),
  });
}

test("projectV1 emits the exact Stage 02 body, boundary head, and segment tuple", () => {
  const value = fixture();
  const result = projectV1(projectorInput(value));
  const expected = buildDeepSeekRequestSnapshotWithTools(
    [value.cacheAbi.systemBlob, value.userBlob],
    value.cacheAbi.toolsBlob,
  );

  assert.equal(bytesEqual(result.body, expected.body), true);
  assert.equal(result.headEventId, value.boundaryEventId);
  assert.deepEqual(result.segmentHashes, [
    value.cacheAbi.headerHash,
    `sha256:${sha256Hex(value.userBlob)}`,
  ]);
  assert.equal(
    result.segmentHashes[1],
    "sha256:421273506b0fce2940698a00c73495774feb85114d4b5b884422d3292515f1a4",
  );
  assert.equal(
    `sha256:${sha256Hex(result.body)}`,
    "sha256:24b6aa2fbaaede596331a644c880b61908a1cff44e220c051c5f9cc614e0ec92",
  );
  assert.equal(result.body.byteLength, 2_301);
  assert.notEqual(result.segmentHashes[0], result.segmentHashes[1]);
  assert.equal(result.blobs.length, 2);
  assert.equal(bytesEqual(result.blobs[0]!, value.cacheAbi.systemBlob), true);
  assert.equal(bytesEqual(result.blobs[1]!, value.userBlob), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.blobs), true);
  assert.equal(Object.isFrozen(result.segmentHashes), true);

  const exposed = result.body.copy();
  exposed[0] = (exposed[0] ?? 0) ^ 1;
  assert.equal(bytesEqual(result.body, expected.body), true);
});

test("legacy fresh projection consumes its loaded v4 tools bytes without upgrade", () => {
  const value = fixture(legacyV4CacheAbi());
  const result = projectV1(projectorInput(value));
  const expected = buildDeepSeekRequestSnapshotWithTools(
    [value.cacheAbi.systemBlob, value.userBlob],
    LEGACY_CANONICAL_TOOLS_BYTES,
  );
  const upgraded = buildDeepSeekRequestSnapshot([
    value.cacheAbi.systemBlob,
    value.userBlob,
  ]);
  assert.equal(bytesEqual(result.body, expected.body), true);
  assert.equal(bytesEqual(result.body, upgraded.body), false);
  assert.equal(
    result.body.byteLength,
    upgraded.body.byteLength -
      (CANONICAL_TOOLS_BYTES.byteLength - LEGACY_CANONICAL_TOOLS_BYTES.byteLength),
  );
});

test("projectV1 rejects every mutated Cache ABI outward identity field", () => {
  const value = fixture();
  const base = value.cacheAbi;
  const forgedValues: readonly FrozenCacheAbiManifest[] = [
    { ...base, cacheAbiId: `sha256:${"0".repeat(64)}` as CacheAbiId },
    {
      ...base,
      protocolVersion: "not-v1" as typeof base.protocolVersion,
    },
    {
      ...base,
      projectorVersion: "not-v1" as typeof base.projectorVersion,
    },
    { ...base, modelTupleBytes: utf8Bytes("wrong model tuple") },
    { ...base, systemBlob: utf8Bytes('{"role":"system","content":"wrong"}') },
    { ...base, toolsBlob: utf8Bytes("[]") },
    { ...base, headerHash: `sha256:${"f".repeat(64)}` as Sha256 },
    { ...base, model: "deepseek-v4.1" } as FrozenCacheAbiManifest,
    { ...base, preset: "pro" } as FrozenCacheAbiManifest,
    { ...base, reasoning_effort: "high" } as FrozenCacheAbiManifest,
    { ...base, thinking: { type: "disabled" } } as FrozenCacheAbiManifest,
    { ...base, endpoint: "https://example.invalid" } as FrozenCacheAbiManifest,
    { ...base, base_url: "https://example.invalid" } as FrozenCacheAbiManifest,
  ];

  for (const cacheAbi of forgedValues) {
    assert.throws(
      () => projectV1({ ...projectorInput(value), cacheAbi }),
      /Cache ABI|manifest/u,
    );
  }

  const corruptedManifest = base.manifestBytes.copy();
  corruptedManifest[0] = (corruptedManifest[0] ?? 0) ^ 1;
  assert.throws(
    () =>
      projectV1({
        ...projectorInput(value),
        cacheAbi: {
          ...base,
          manifestBytes: freezeBytes(corruptedManifest),
        } as FrozenCacheAbiManifest,
      }),
    /Cache ABI/u,
  );
});

test("pure projector owns a fixed production dependency closure", () => {
  const closure = projectorProductionClosure();
  assert.deepEqual(closure.files, PROJECTOR_PRODUCTION_CLOSURE);
  assert.deepEqual(closure.ambientImports, ["node:crypto"]);

  const forbiddenAmbientGlobals = [
    /\bprocess\b/u,
    /\bglobalThis\b/u,
    /\bfetch\b/u,
    /\bperformance\b/u,
    /\bMath\.random\b/u,
    /\brandomUUID\b/u,
    /\brandomBytes\b/u,
    /\bwebcrypto\b/u,
    /\bDate\.now\b/u,
    /\bnew\s+Date\s*\(\s*\)/u,
    /\bset(?:Timeout|Interval)\b/u,
    /\bqueueMicrotask\b/u,
  ] as const;
  for (const file of closure.files) {
    const source = readFileSync(file, "utf8");
    for (const forbidden of forbiddenAmbientGlobals) {
      assert.doesNotMatch(source, forbidden, file);
    }
  }
});

test("pure projector neither reads ambient state nor admits env secret bytes", () => {
  const source = readFileSync("src/ctx/projector.ts", "utf8");
  for (const forbidden of [
    /node:fs/u,
    /node:https/u,
    /process\.env/u,
    /process\.cwd/u,
    /\bfetch\s*\(/u,
    /\bDate\b/u,
    /CredentialLoader/u,
    /\.env/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }

  const value = fixture();
  const sentinel = "SIMPLEDSH_DOTENV_SECRET_SENTINEL_8f1d94";
  const environmentKey = "SIMPLEDSH_PROJECTOR_TEST_SENTINEL";
  const prior = process.env[environmentKey];
  const originalCwd = process.cwd;
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  process.env[environmentKey] = sentinel;
  process.cwd = () => {
    throw new Error("pure projector read cwd");
  };
  Date.now = () => {
    throw new Error("pure projector read time");
  };
  globalThis.fetch = () => {
    throw new Error("pure projector used network");
  };

  let bodyText = "";
  try {
    bodyText = utf8View(projectV1(projectorInput(value)).body);
  } finally {
    process.cwd = originalCwd;
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    if (prior === undefined) delete process.env[environmentKey];
    else process.env[environmentKey] = prior;
  }
  assert.equal(bodyText.includes(sentinel), false);

  const secretBlobRef = `blobs/sha256/${"e".repeat(64)}` as BlobRef;
  assert.throws(
    () =>
      projectV1({
        ...projectorInput(value),
        externalBlobs: new Map([[secretBlobRef, utf8Bytes(sentinel)]]),
      }),
    /external Blob/u,
  );
});
