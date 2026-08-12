// Ported from Pi's TUI package.
//   https://github.com/earendil-works/pi @ 05bf9df65155e047e4ba8459eaee9735e29a2e53
//   packages/tui/src/undo-stack.ts
// Copyright (c) 2025 Mario Zechner. MIT License.
// Adapted for FlashCoder: .ts import specifiers changed to .js for NodeNext.

/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 */
export class UndoStack<S> {
	private stack: S[] = [];

	/** Push a deep clone of the given state onto the stack. */
	push(state: S): void {
		this.stack.push(structuredClone(state));
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
