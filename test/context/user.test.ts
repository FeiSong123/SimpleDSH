import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex, utf8Bytes } from "../../src/bytes/ops.js";
import { freezeBytes, FrozenBytes } from "../../src/bytes/types.js";
import {
  materializeUserV1,
  type UserFactInput,
} from "../../src/ctx/user.js";
import type {
  ArtifactId,
  ArtifactRef,
  CanonicalTimestamp,
  EventId,
  LineageId,
  RunId,
  SessionId,
  Sha256,
} from "../../src/journal/types.js";

type FactKind = UserFactInput["fact"]["payload"]["kind"];

const SESSION_ID = `ses_${"1".repeat(32)}` as SessionId;
const OTHER_SESSION_ID = `ses_${"2".repeat(32)}` as SessionId;
const LINEAGE_ID = `lin_${"3".repeat(32)}` as LineageId;
const OTHER_LINEAGE_ID = `lin_${"4".repeat(32)}` as LineageId;
const RUN_ID = `run_${"5".repeat(32)}` as RunId;
const OTHER_RUN_ID = `run_${"6".repeat(32)}` as RunId;
const TIMESTAMP = "2026-08-04T00:00:00.000Z" as CanonicalTimestamp;
const decoder = new TextDecoder("utf-8", { fatal: true });

function hashFor(value: number): Sha256 {
  return `sha256:${value.toString(16).padStart(64, "0")}` as Sha256;
}

function eventIdFor(value: number): EventId {
  return `evt_${value.toString(16).padStart(32, "0")}` as EventId;
}

function artifactIdFor(value: number): ArtifactId {
  return `art_${value.toString(16).padStart(32, "0")}` as ArtifactId;
}

function entryFromBytes(
  kind: FactKind,
  bytes: FrozenBytes,
  ordinal: number,
): UserFactInput {
  const publishedSeq = ordinal * 2 + 1;
  const factSeq = publishedSeq + 1;
  const digestHex = sha256Hex(bytes);
  const artifactHash = `sha256:${digestHex}` as Sha256;
  const artifactId = artifactIdFor(ordinal);
  return Object.freeze({
    bytes,
    published: Object.freeze({
      v: 1,
      seq: publishedSeq,
      id: eventIdFor(publishedSeq),
      type: "artifact_published",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      at: TIMESTAMP,
      payload: Object.freeze({
        artifactId,
        artifactRef: `artifacts/sha256/${digestHex}` as ArtifactRef,
        artifactHash,
        byteCount: bytes.byteLength,
        lineCount: null,
        mediaType: "text/plain; charset=utf-8",
        artifactType: "fact",
        streamBytes: null,
        hardLimitReached: null,
        descendantsReaped: null,
        toolCallId: null,
        terminal: null,
      }),
      prevHash: hashFor(Math.max(0, publishedSeq - 1)),
      hash: hashFor(publishedSeq),
    }),
    fact: Object.freeze({
      v: 1,
      seq: factSeq,
      id: eventIdFor(factSeq),
      type: "fact_recorded",
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      runId: RUN_ID,
      at: TIMESTAMP,
      payload: Object.freeze({
        kind,
        artifactId,
        byteCount: bytes.byteLength,
      }),
      prevHash: hashFor(publishedSeq),
      hash: hashFor(factSeq),
    }),
  });
}

function entry(kind: FactKind, value: string, ordinal: number): UserFactInput {
  return entryFromBytes(kind, utf8Bytes(value), ordinal);
}

function cloneEntry(
  source: UserFactInput,
  patch: Partial<UserFactInput>,
): UserFactInput {
  return { ...source, ...patch };
}

function expectInvalid(facts: readonly UserFactInput[]): void {
  assert.throws(
    () => materializeUserV1({ facts }),
    /invalid v1 user fact materialization input/u,
  );
}

test("materializeUserV1 freezes the canonical Unicode user-message golden", () => {
  const user = entry("user_input", "你好🙂", 10);
  const result = materializeUserV1({ facts: [user] });

  assert.equal(
    decoder.decode(result.blob.copy()),
    '{"role":"user","content":"你好🙂"}',
  );
  assert.equal(result.blob.byteLength, 38);
  assert.equal(
    `sha256:${sha256Hex(result.blob)}`,
    "sha256:6307657260b3df101cac4a96532f2ffc330eeea76e0078b342d11529d3c6639f",
  );
  assert.deepEqual(result.sourceFactEventIds, [user.fact.id]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.sourceFactEventIds), true);
});

test("materializeUserV1 emits the exact ordered environment block golden", () => {
  const facts = [
    entry("user_input", "修复测试\n保留字节\0", 10),
    entry("date", "2026-08-04", 11),
    entry("cwd", "/work/项目", 12),
    entry("git", "branch: main\nstatus: clean", 13),
  ] as const;
  const result = materializeUserV1({ facts });

  assert.equal(
    decoder.decode(result.blob.copy()),
    '{"role":"user","content":"修复测试\\n保留字节\\u0000\\n\\n<env>\\ndate:\\n2026-08-04\\ncwd:\\n/work/项目\\ngit:\\nbranch: main\\nstatus: clean\\n</env>"}',
  );
  assert.equal(result.blob.byteLength, 151);
  assert.equal(
    `sha256:${sha256Hex(result.blob)}`,
    "sha256:2bc7a8cf38682c8b9c6d5fb3a2d5e0039e3f5ff30380688964631bc15adab281",
  );
  assert.deepEqual(
    result.sourceFactEventIds,
    facts.map((fact) => fact.fact.id),
  );
});

test("materializeUserV1 permits omitted environment kinds without placeholders", () => {
  const result = materializeUserV1({
    facts: [
      entry("user_input", "continue", 10),
      entry("cwd", "/workspace", 11),
    ],
  });
  assert.equal(
    decoder.decode(result.blob.copy()),
    '{"role":"user","content":"continue\\n\\n<env>\\ncwd:\\n/workspace\\n</env>"}',
  );
});

test("materializeUserV1 defensively owns its result", () => {
  const user = entry("user_input", "immutable", 10);
  const mutableFacts: UserFactInput[] = [user];
  const result = materializeUserV1({ facts: mutableFacts });
  mutableFacts.length = 0;
  const copy = result.blob.copy();
  copy.fill(0);

  assert.deepEqual(result.sourceFactEventIds, [user.fact.id]);
  assert.equal(
    decoder.decode(result.blob.copy()),
    '{"role":"user","content":"immutable"}',
  );
});

test("materializeUserV1 rejects absent empty duplicate unordered or unsupported facts", () => {
  expectInvalid([]);
  expectInvalid([entry("date", "2026-08-04", 10)]);
  expectInvalid([entry("user_input", "", 10)]);
  expectInvalid([
    entry("user_input", "one", 10),
    entry("user_input", "two", 11),
  ]);
  expectInvalid([
    entry("user_input", "one", 10),
    entry("cwd", "/workspace", 11),
    entry("date", "2026-08-04", 12),
  ]);
  expectInvalid([
    entry("user_input", "one", 10),
    entry("project_instructions", "forbidden", 11),
  ]);
});

test("materializeUserV1 rejects invalid UTF-8 in every fact kind", () => {
  expectInvalid([
    entryFromBytes(
      "user_input",
      freezeBytes(Uint8Array.from([0xc3, 0x28])),
      10,
    ),
  ]);
  expectInvalid([
    entry("user_input", "one", 10),
    entryFromBytes("git", freezeBytes(Uint8Array.from([0xff])), 11),
  ]);
});

test("materializeUserV1 rejects publisher fact and cross-entry scope mismatches", () => {
  const user = entry("user_input", "one", 10);
  const other = entry("date", "2026-08-04", 11);

  expectInvalid([
    cloneEntry(user, {
      published: { ...user.published, sessionId: OTHER_SESSION_ID },
    }),
  ]);
  expectInvalid([
    cloneEntry(user, {
      fact: { ...user.fact, lineageId: OTHER_LINEAGE_ID },
    }),
  ]);
  expectInvalid([
    cloneEntry(user, {
      published: { ...user.published, runId: OTHER_RUN_ID },
    }),
  ]);
  expectInvalid([
    user,
    cloneEntry(other, {
      fact: { ...other.fact, runId: OTHER_RUN_ID },
      published: { ...other.published, runId: OTHER_RUN_ID },
    }),
  ]);

  const noRunPublisher = { ...user.published };
  delete noRunPublisher.runId;
  expectInvalid([cloneEntry(user, { published: noRunPublisher })]);

  const noLineageFact = { ...user.fact };
  delete noLineageFact.lineageId;
  expectInvalid([cloneEntry(user, { fact: noLineageFact })]);
});

test("materializeUserV1 rejects creator and fact ordering violations", () => {
  const user = entry("user_input", "one", 10);
  const date = entry("date", "2026-08-04", 11);

  expectInvalid([
    cloneEntry(user, {
      published: { ...user.published, seq: user.fact.seq },
    }),
  ]);
  expectInvalid([
    user,
    cloneEntry(date, {
      published: { ...date.published, seq: user.published.seq - 2 },
      fact: { ...date.fact, seq: user.fact.seq - 1 },
    }),
  ]);
  expectInvalid([
    user,
    cloneEntry(date, {
      fact: { ...date.fact, id: user.fact.id },
    }),
  ]);
});

test("materializeUserV1 rejects Artifact identity hash ref count and type drift", () => {
  const user = entry("user_input", "one", 10);
  const wrongArtifactId = artifactIdFor(99);

  expectInvalid([
    cloneEntry(user, {
      fact: {
        ...user.fact,
        payload: { ...user.fact.payload, artifactId: wrongArtifactId },
      },
    }),
  ]);
  expectInvalid([
    cloneEntry(user, {
      published: {
        ...user.published,
        payload: { ...user.published.payload, artifactHash: hashFor(99) },
      },
    }),
  ]);
  expectInvalid([
    cloneEntry(user, {
      published: {
        ...user.published,
        payload: {
          ...user.published.payload,
          artifactRef: `artifacts/sha256/${"f".repeat(64)}` as ArtifactRef,
        },
      },
    }),
  ]);
  expectInvalid([
    cloneEntry(user, {
      published: {
        ...user.published,
        payload: {
          ...user.published.payload,
          byteCount: user.bytes.byteLength + 1,
        },
      },
    }),
  ]);
  expectInvalid([
    cloneEntry(user, {
      fact: {
        ...user.fact,
        payload: { ...user.fact.payload, byteCount: user.bytes.byteLength + 1 },
      },
    }),
  ]);
  expectInvalid([
    cloneEntry(user, {
      published: {
        ...user.published,
        payload: { ...user.published.payload, artifactType: "user_state" },
      },
    }),
  ]);
});

test("materializeUserV1 accepts only FrozenBytes", () => {
  const user = entry("user_input", "one", 10);
  assert.throws(
    () =>
      materializeUserV1({
        facts: [
          cloneEntry(user, {
            bytes: Uint8Array.from(user.bytes.copy()) as unknown as FrozenBytes,
          }),
        ],
      }),
    /invalid v1 user fact materialization input/u,
  );
});
