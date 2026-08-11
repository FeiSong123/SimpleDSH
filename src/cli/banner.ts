/**
 * What the terminal shows before anything has happened.
 *
 * It says what this is, what it believes, and what this run is pointed at, and
 * then gets out of the way. No feature list: the first screen of a coding agent
 * should not narrow the thing to whichever mechanism was built most recently.
 */

import { truncateToWidth, visibleWidth } from "../tui/index.js";
import { color } from "./theme.js";

const ART = [
  " ____  _                 _      ____  ____  _   _",
  "/ ___|(_)_ __ ___  _ __ | | ___|  _ \\/ ___|| | | |",
  "\\___ \\| | '_ ` _ \\| '_ \\| |/ _ \\ | | \\___ \\| |_| |",
  " ___) | | | | | | | |_) | |  __/ |_| |___) |  _  |",
  "|____/|_|_| |_| |_| .__/|_|\\___|____/|____/|_| |_|",
  "                  |_|",
] as const;

export const TAGLINE = "Simple Harness for DeepSeek Models";
/**
 * Four claims, worded so the two rows they fold into come out the same length.
 * A ragged pair reads as a wrap; an even pair reads as a deliberate list.
 */
export const PHILOSOPHY =
  "DeepSeek-native Design · Cache-first Arch · Durable Sessions · Simple and Efficient";

/** What the philosophy line is broken at when it will not fit on one row. */
const SEPARATOR = " · ";

/** Deep ocean to aurora: cyan, electric blue, violet, magenta. */
const STOPS = [
  [0x35, 0xd7, 0xff],
  [0x5b, 0x7c, 0xfa],
  [0x8b, 0x5c, 0xf6],
  [0xd9, 0x46, 0xef],
] as const;

const TAGLINE_RGB = [0xe6, 0xed, 0xf3] as const;
const PHILOSOPHY_RGB = [0x8b, 0x96, 0xa8] as const;

/** Rows shift the gradient sideways, so the sweep runs on a slight diagonal. */
const SLANT = 1.8;

/** Space between the box and what it holds, on both sides. */
const INSET = 3;

/** Under this the box costs more room than it frames. */
const NARROWEST_BOX = 44;

export interface RunContext {
  readonly model: string;
  readonly effort: string;
  readonly directory: string;
}

function truecolor(): boolean {
  if (process.env["NO_COLOR"] !== undefined) return false;
  if (process.stdout.isTTY !== true) return false;
  const declared = process.env["COLORTERM"] ?? "";
  return declared.includes("truecolor") || declared.includes("24bit");
}

function mix(at: number): readonly [number, number, number] {
  const span = 1 / (STOPS.length - 1);
  const index = Math.min(STOPS.length - 2, Math.floor(at / span));
  const from = STOPS[index] ?? STOPS[0];
  const to = STOPS[index + 1] ?? STOPS[STOPS.length - 1] ?? STOPS[0];
  const t = Math.min(1, Math.max(0, (at - index * span) / span));
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

function paint(
  rgb: readonly [number, number, number] | readonly number[],
): string {
  return `\u001b[38;2;${String(rgb[0])};${String(rgb[1])};${String(rgb[2])}m`;
}

const RESET = "\u001b[0m";

/**
 * The art with a gradient swept across it, or plain text when the terminal
 * cannot show one.
 *
 * The gradient is measured against the widest row rather than each row's own
 * length, so a short row keeps the colour it would have had — otherwise every
 * line would restart at cyan and the sweep would look like stripes.
 */
function artwork(): readonly string[] {
  if (!truecolor()) return ART;
  const width = Math.max(...ART.map((row) => row.length));
  const reach = width + ART.length * SLANT;
  return ART.map((row, y) => {
    let painted = "";
    let last = "";
    for (const [x, character] of [...row].entries()) {
      if (character === " ") {
        painted += character;
        continue;
      }
      const code = paint(mix(Math.min(1, (x + y * SLANT) / reach)));
      if (code !== last) {
        painted += code;
        last = code;
      }
      painted += character;
    }
    return painted.length === 0 ? row : `${painted}${RESET}`;
  });
}

/**
 * The philosophy line, folded onto as few rows as the room allows.
 *
 * It breaks only at the separators, so a phrase is never split across rows and
 * the fold reads as a deliberate list rather than a wrap.
 */
function fold(room: number): readonly string[] {
  const rows: string[] = [];
  let row = "";
  for (const part of PHILOSOPHY.split(SEPARATOR)) {
    const candidate = row === "" ? part : `${row}${SEPARATOR}${part}`;
    if (row !== "" && candidate.length > room) {
      rows.push(row);
      row = part;
      continue;
    }
    row = candidate;
  }
  if (row !== "") rows.push(row);
  return rows;
}

/** `model      deepseek-v4-flash · effort max`, values in one column. */
function facts(context: RunContext): readonly string[] {
  const rows = [
    ["model", `${context.model} · effort ${context.effort}`],
    ["directory", context.directory],
  ] as const;
  const label = Math.max(...rows.map(([name]) => name.length)) + 2;
  return rows.map(
    ([name, value]) => `${color.dim(name.padEnd(label))}${color.tool(value)}`,
  );
}

/**
 * Draw a rounded box around finished lines.
 *
 * Contents are measured with `visibleWidth` because every line here is already
 * painted; counting the escape sequences would push the right edge off screen.
 * A line wider than the box is cut with an ellipsis: a box with one row hanging
 * past its own border reads as a rendering fault rather than a long value.
 */
function boxed(lines: readonly string[], width: number): readonly string[] {
  const inner = width - 2;
  const bar = color.border("│");
  const rule = (left: string, right: string): string =>
    color.border(left + "─".repeat(inner) + right);
  const room = inner - INSET * 2;
  const row = (line: string): string => {
    const shown = visibleWidth(line) > room ? truncateToWidth(line, room, "…") : line;
    const pad = " ".repeat(Math.max(0, room - visibleWidth(shown)));
    const gap = " ".repeat(INSET);
    return `${bar}${gap}${shown}${pad}${gap}${bar}`;
  };
  return [rule("╭", "╮"), row(""), ...lines.map(row), row(""), rule("╰", "╯")];
}

/**
 * The whole opening block, ready to print one line at a time.
 *
 * `columns` is the room the block may occupy, not the terminal width — the
 * caller knows what padding it adds around what it prints.
 */
export function banner(
  columns: number,
  context: RunContext,
): readonly string[] {
  const artWidth = Math.max(...ART.map((row) => row.length));
  const room = Math.max(1, columns - INSET * 2 - 2);
  // Fold against the wordmark rather than the window: on a wide terminal the
  // line fits on one row and drags the box out to twice the width of what it
  // is framing.
  const fit = Math.min(room, artWidth + INSET * 2);
  const body: string[] = [];
  if (room >= artWidth) body.push(...artwork());
  else body.push(color.bold("SimpleDSH"));
  body.push(
    "",
    truecolor() ? `${paint(TAGLINE_RGB)}${TAGLINE}${RESET}` : TAGLINE,
    "",
    ...fold(fit).map((line) =>
      truecolor() ? `${paint(PHILOSOPHY_RGB)}${line}${RESET}` : color.dim(line),
    ),
    "",
    ...facts(context),
  );

  if (columns < NARROWEST_BOX) {
    return Object.freeze(body.filter((line) => line !== ""));
  }
  // Fit the box to what it holds rather than to the terminal. A frame drawn out
  // to column 200 is mostly empty space with a line around it.
  const content = Math.max(...body.map((line) => visibleWidth(line)));
  const width = Math.min(columns, content + INSET * 2 + 2);
  return Object.freeze([...boxed(body, width)]);
}
