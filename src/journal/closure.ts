export interface CommitClosureStateV1 {
  readonly openModelResponses: number;
  readonly pendingToolCalls: number;
  readonly unsettledEffects: number;
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isCommitClosureV1(state: CommitClosureStateV1): boolean {
  if (
    !isCount(state.openModelResponses) ||
    !isCount(state.pendingToolCalls) ||
    !isCount(state.unsettledEffects)
  ) {
    throw new TypeError("invalid commit closure counts");
  }
  return (
    state.openModelResponses === 0 &&
    state.pendingToolCalls === 0 &&
    state.unsettledEffects === 0
  );
}
