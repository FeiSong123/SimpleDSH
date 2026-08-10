import assert from "node:assert/strict";
import test from "node:test";

import {
  RECOVERY_CRASH_MATRIX_V1,
  RECOVERY_CRASH_MATRIX_V2,
  RECOVERY_PARTIAL_INITIALIZATION_V2,
  RECOVERY_RECONCILIATION_SEAMS_V2,
  RECOVERY_REQUEST_DERIVED_TERMINALS_V2,
  RECOVERY_T1_ARTIFACT_AUTHORITY_V2,
} from "./crash-matrix.js";

function unique<Value>(values: readonly Value[]): boolean {
  return new Set(values).size === values.length;
}

test("v2 crash matrix has one finite entry for every fresh-review cut", () => {
  assert.equal(RECOVERY_CRASH_MATRIX_V2.version, 2);
  assert.equal(unique(RECOVERY_CRASH_MATRIX_V2.entries.map(({ id }) => id)), true);
  assert.equal(
    unique(RECOVERY_CRASH_MATRIX_V2.entries.map(({ testName }) => testName)),
    true,
  );

  const cutIds = new Set(
    RECOVERY_CRASH_MATRIX_V2.entries
      .slice(RECOVERY_CRASH_MATRIX_V1.length)
      .map(({ id }) => id),
  );
  assert.deepEqual(cutIds, new Set([
    "I02",
    "I03",
    "R09a",
    "A10a",
    "E12r",
    "Q23",
    "Q24",
    "Q25",
    "Q26",
  ]));
});

test("partial bootstrap enumerates every durable identity and source-fact phase", () => {
  assert.deepEqual(
    RECOVERY_PARTIAL_INITIALIZATION_V2.cases.map(({ id }) => id),
    [
      "physical_bootstrap_without_session",
      "session_started",
      "cache_manifest_artifact",
      "cache_abi_declared",
      "lineage_started",
      "lineage_activated",
      "run_started",
      "orphan_user_fact_artifact",
      "user_input_fact",
      "partial_environment_artifact",
      "partial_environment_facts",
      "all_source_facts_without_user",
    ],
  );
  for (const crashCase of RECOVERY_PARTIAL_INITIALIZATION_V2.cases) {
    assert.equal(crashCase.recoverableUserTask, false);
    assert.ok(crashCase.forbidden.includes("materialize_user"));
    assert.ok(crashCase.forbidden.includes("start_successor_run"));
    assert.ok(crashCase.forbidden.includes("project"));
    assert.ok(crashCase.forbidden.includes("send"));
    assert.ok(crashCase.forbidden.includes("invoke_tool"));
    if (crashCase.matrixId === "I02") {
      assert.equal(crashCase.oldRunClosureUpperBound, 0);
      assert.equal(crashCase.allowedOutcome, "read_only_incomplete");
      assert.ok(crashCase.forbidden.includes("fabricate_run_terminal"));
    } else {
      assert.equal(crashCase.oldRunClosureUpperBound, 1);
      assert.equal(
        crashCase.allowedOutcome,
        "interrupt_old_run_once_then_stop",
      );
      assert.ok(crashCase.forbidden.includes("guess_fact_set"));
    }
  }
});

test("durable T1 read Artifact reconstructs its result without another read", () => {
  const unreferenced = RECOVERY_T1_ARTIFACT_AUTHORITY_V2.cases.find(
    ({ id }) => id === "unreferenced_cas_bytes",
  );
  const durable = RECOVERY_T1_ARTIFACT_AUTHORITY_V2.cases.find(
    ({ id }) => id === "durable_artifact_event",
  );
  assert.ok(unreferenced);
  assert.ok(durable);
  assert.equal(unreferenced.artifactIsJournalFact, false);
  assert.equal(unreferenced.allowedAction, "rerun_read");
  assert.equal(unreferenced.additionalReadInvocationsUpperBound, 1);
  assert.equal(durable.artifactIsJournalFact, true);
  assert.equal(durable.allowedAction, "reconstruct_result");
  assert.equal(durable.additionalReadInvocationsUpperBound, 0);
  assert.equal(durable.additionalArtifactEventsUpperBound, 0);
  assert.equal(durable.additionalToolResultsUpperBound, 1);
});

test("request-derived terminal seams never duplicate attempt terminal or Checkpoint", () => {
  assert.deepEqual(
    RECOVERY_REQUEST_DERIVED_TERMINALS_V2.cases.map(({ id }) => id),
    [
      "request_interrupted_before_run_interrupted",
      "assistant_before_checkpoint",
      "tool_checkpoint_before_pending_continuation",
      "final_checkpoint_before_final_boundary",
    ],
  );
  for (const crashCase of RECOVERY_REQUEST_DERIVED_TERMINALS_V2.cases) {
    assert.equal(crashCase.additionalRequestTerminalsUpperBound, 0);
    assert.ok(crashCase.additionalCheckpointsUpperBound <= 1);
  }
  assert.equal(
    RECOVERY_REQUEST_DERIVED_TERMINALS_V2.cases[1]
      ?.additionalCheckpointsUpperBound,
    1,
  );
  assert.equal(
    RECOVERY_REQUEST_DERIVED_TERMINALS_V2.cases
      .filter(({ id }) => id !== "assistant_before_checkpoint")
      .every(({ additionalCheckpointsUpperBound }) =>
        additionalCheckpointsUpperBound === 0),
    true,
  );
});

test("each reconciliation Artifact event and continuation seam has a finite convergence bound", () => {
  assert.deepEqual(
    RECOVERY_RECONCILIATION_SEAMS_V2.cases.map(({ id }) => id),
    [
      "q23_completed_evidence",
      "q23_not_executed_evidence",
      "q24_completed_output",
      "q25_completed_resolution",
      "q25_not_executed_resolution",
      "q26_result",
      "q26_boundary",
      "q26_snapshot",
    ],
  );
  for (const crashCase of RECOVERY_RECONCILIATION_SEAMS_V2.cases) {
    assert.equal(crashCase.additionalEvidenceArtifactsUpperBound, 0);
    assert.ok(crashCase.additionalOutputArtifactsUpperBound <= 1);
    assert.ok(crashCase.additionalReconciliationEventsUpperBound <= 1);
    assert.ok(crashCase.additionalToolResultsUpperBound <= 1);
    assert.ok(crashCase.additionalExternalInvocationsUpperBound <= 1);
  }

  const afterResolution = RECOVERY_RECONCILIATION_SEAMS_V2.cases.filter(
    ({ matrixId }) => matrixId === "Q25" || matrixId === "Q26",
  );
  assert.equal(
    afterResolution.every(
      ({ additionalReconciliationEventsUpperBound }) =>
        additionalReconciliationEventsUpperBound === 0,
    ),
    true,
  );
  assert.deepEqual(
    RECOVERY_RECONCILIATION_SEAMS_V2.cases
      .filter(
        ({ additionalExternalInvocationsUpperBound }) =>
          additionalExternalInvocationsUpperBound === 1,
      )
      .map(({ id }) => id),
    ["q23_not_executed_evidence", "q25_not_executed_resolution"],
  );
  for (const continuation of RECOVERY_RECONCILIATION_SEAMS_V2.cases.filter(
    ({ matrixId }) => matrixId === "Q26",
  )) {
    assert.deepEqual(
      {
        evidence: continuation.additionalEvidenceArtifactsUpperBound,
        output: continuation.additionalOutputArtifactsUpperBound,
        reconciliation:
          continuation.additionalReconciliationEventsUpperBound,
        result: continuation.additionalToolResultsUpperBound,
        external: continuation.additionalExternalInvocationsUpperBound,
      },
      {
        evidence: 0,
        output: 0,
        reconciliation: 0,
        result: 0,
        external: 0,
      },
    );
  }
});

test("v2 preserves the conservative R05-R09 request closure mapping exactly", () => {
  assert.deepEqual(RECOVERY_CRASH_MATRIX_V2.preservedRequestClosureIds, [
    "R05",
    "R06",
    "R07",
    "R08",
    "R09",
  ]);
  for (const id of RECOVERY_CRASH_MATRIX_V2.preservedRequestClosureIds) {
    const v1 = RECOVERY_CRASH_MATRIX_V1.find((entry) => entry.id === id);
    const v2 = RECOVERY_CRASH_MATRIX_V2.entries.find(
      (entry) => entry.id === id,
    );
    assert.ok(v1);
    assert.strictEqual(v2, v1);
  }
});

test("all v2 recovery contract containers are immutable data", () => {
  const containers = [
    RECOVERY_CRASH_MATRIX_V2,
    RECOVERY_PARTIAL_INITIALIZATION_V2,
    RECOVERY_T1_ARTIFACT_AUTHORITY_V2,
    RECOVERY_REQUEST_DERIVED_TERMINALS_V2,
    RECOVERY_RECONCILIATION_SEAMS_V2,
  ] as const;
  for (const container of containers) {
    assert.equal(Object.isFrozen(container), true);
  }
  const entryLists = [
    RECOVERY_CRASH_MATRIX_V2.entries,
    RECOVERY_PARTIAL_INITIALIZATION_V2.cases,
    RECOVERY_T1_ARTIFACT_AUTHORITY_V2.cases,
    RECOVERY_REQUEST_DERIVED_TERMINALS_V2.cases,
    RECOVERY_RECONCILIATION_SEAMS_V2.cases,
  ] as const;
  for (const entries of entryLists) {
    assert.equal(Object.isFrozen(entries), true);
    assert.equal(entries.every((entry) => Object.isFrozen(entry)), true);
  }
  assert.equal(
    RECOVERY_PARTIAL_INITIALIZATION_V2.cases.every(({ forbidden }) =>
      Object.isFrozen(forbidden)),
    true,
  );
});
