/**
 * What the terminal shows before anything has happened.
 *
 * It says what this is and what it believes, and then gets out of the way. No
 * feature list: the first screen of a coding agent should not narrow the thing
 * to whichever mechanism was built most recently.
 */

const ART = [
  " ____  _                 _      ____  ____  _   _",
  "/ ___|(_)_ __ ___  _ __ | | ___|  _ \\/ ___|| | | |",
  "\\___ \\| | '_ ` _ \\| '_ \\| |/ _ \\ | | \\___ \\| |_| |",
  " ___) | | | | | | | |_) | |  __/ |_| |___) |  _  |",
  "|____/|_|_| |_| |_| .__/|_|\\___|____/|____/|_| |_|",
  "                  |_|",
] as const;

export const TAGLINE = "Simple Harness for DeepSeek Models";
export const PHILOSOPHY = [
  "Minimal harness. Full model agency.",
  "Deliberate scope. Efficient execution.",
] as const;

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

function paint(rgb: readonly [number, number, number] | readonly number[]): string {
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
export function banner(columns: number): readonly string[] {
  const width = Math.max(...ART.map((row) => row.length));
  if (columns < width + 2) {
    return Object.freeze([
      "SimpleDSH",
      "",
      TAGLINE,
      "",
      ...PHILOSOPHY,
    ]);
  }
  if (!truecolor()) {
    return Object.freeze([...ART, "", TAGLINE, "", ...PHILOSOPHY]);
  }

  const reach = width + ART.length * SLANT;
  const art = ART.map((row, y) => {
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

  return Object.freeze([
    ...art,
    "",
    `${paint(TAGLINE_RGB)}${TAGLINE}${RESET}`,
    "",
    ...PHILOSOPHY.map((line) => `${paint(PHILOSOPHY_RGB)}${line}${RESET}`),
  ]);
}
