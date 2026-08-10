// Ported from Pi's TUI package.
//   https://github.com/earendil-works/pi @ 05bf9df65155e047e4ba8459eaee9735e29a2e53
//   packages/tui/src/components/v-stack.ts
// Copyright (c) 2025 Mario Zechner. MIT License.
// Adapted for SimpleDSH: .ts import specifiers changed to .js for NodeNext.

import { allocateStackSizes, Stack, type StackChild, type StackOptions, visibleStackEntries } from "./stack.js";

export class VStack extends Stack {
	protected readonly layoutType = "vstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override render(width: number): string[] {
		const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport);
		const rendered = entries.map((entry) => entry.component.render(viewport.width));
		const sizes = allocateStackSizes(
			entries,
			rendered.map((lines) => lines.length),
			undefined,
			this.gap,
		);
		const lines: string[] = [];
		for (let index = 0; index < entries.length; index++) {
			if (index > 0) {
				for (let gap = 0; gap < this.gap; gap++) lines.push("");
			}
			const childLines = rendered[index]!.slice(0, sizes[index]);
			lines.push(...childLines);
			for (let padding = childLines.length; padding < sizes[index]!; padding++) lines.push("");
		}
		return lines;
	}
}

export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.js";
