import type { SessionVerification } from "../session/index.js";
import {
  runGate,
  takeInventory,
  type GateResult,
  type GateSpec,
  type Inventory,
} from "../verify/gate.js";
import type { BashChildEnvironment } from "../proc/index.js";

/** Bounded, so a check that can never pass cannot loop forever. */
export const MAX_VERIFICATION_RETRIES = 3;

/**
 * The declared check, frozen for the whole invocation.
 *
 * The baseline is taken once, before the model has run, and reused for every
 * turn. Re-measuring it per turn would launder tampering: a file edited in the
 * first turn would become the second turn's baseline and stop counting as a
 * change.
 */
export class DeclaredVerification implements SessionVerification {
  readonly #spec: GateSpec;
  readonly #workspaceRoot: string;
  readonly #baseline: Inventory;
  readonly #childEnvironment: BashChildEnvironment;
  #last: GateResult | null = null;

  private constructor(
    spec: GateSpec,
    workspaceRoot: string,
    baseline: Inventory,
    childEnvironment: BashChildEnvironment,
  ) {
    this.#spec = spec;
    this.#workspaceRoot = workspaceRoot;
    this.#baseline = baseline;
    this.#childEnvironment = childEnvironment;
  }

  static async declare(
    spec: GateSpec,
    workspaceRoot: string,
    childEnvironment: BashChildEnvironment,
  ): Promise<DeclaredVerification> {
    return new DeclaredVerification(
      spec,
      workspaceRoot,
      await takeInventory(workspaceRoot, spec.protectedPaths),
      childEnvironment,
    );
  }

  /** The most recent verdict, for the message that goes back to the model. */
  get last(): GateResult | null {
    return this.#last;
  }

  async run(signal: AbortSignal): Promise<GateResult> {
    this.#last = await runGate(
      this.#spec,
      this.#workspaceRoot,
      this.#baseline,
      this.#childEnvironment,
      signal,
    );
    return this.#last;
  }
}

/**
 * What the model is told after a failed check.
 *
 * The command itself is never included — naming it would hand over the answer
 * (`pytest tests/test_add.py::test_returns_sum` says what the fix must be).
 * Its output is included verbatim: a failing assertion is the most informative
 * form the failure has, and anything the harness wrote instead would be a
 * second opinion about work the harness did not do.
 */
export function verificationContinuation(result: GateResult): string {
  return `The verification check failed.\n\n${result.output.trim()}\n\nFix the cause. Do not modify the check itself.`;
}

/** Whether another turn is worth taking. */
export function isRetryable(outcome: string): boolean {
  return outcome === "failed";
}
