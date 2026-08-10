/** ANSI colours for the interactive layer. Plain text when the terminal says no. */

import type { EditorTheme } from "../tui/components/editor.js";
import type { MarkdownTheme } from "../tui/components/markdown.js";

const enabled =
  process.env["NO_COLOR"] === undefined && process.stdout.isTTY === true;

function paint(code: string): (text: string) => string {
  return enabled ? (text) => `\u001b[${code}m${text}\u001b[0m` : (text) => text;
}

export const color = Object.freeze({
  dim: paint("2"),
  bold: paint("1"),
  /** The agent's own actions: reads, commands, edits. */
  tool: paint("36"),
  ok: paint("32"),
  warn: paint("33"),
  error: paint("31"),
  /**
   * Echo of what the user asked.
   *
   * Dim on purpose: you already know what you typed, so it stays out of the
   * way of the agent's actions and its answer.
   */
  prompt: paint("2"),
  border: paint("90"),
});

export const editorTheme: EditorTheme = Object.freeze({
  borderColor: color.border,
  selectList: Object.freeze({
    selectedPrefix: color.tool,
    selectedText: color.bold,
    description: color.dim,
    scrollInfo: color.dim,
    noMatch: color.dim,
  }),
});

/**
 * How the model's Markdown is drawn.
 *
 * Deliberately restrained: this is a transcript people read while working, so
 * emphasis marks structure rather than competing with the agent's own output.
 */
export const markdownTheme: MarkdownTheme = Object.freeze({
  heading: (text: string) => color.bold(color.tool(text)),
  link: paint("4;36"),
  linkUrl: color.dim,
  code: paint("33"),
  codeBlock: paint("33"),
  codeBlockBorder: color.border,
  quote: color.dim,
  quoteBorder: color.border,
  hr: color.border,
  listBullet: color.tool,
  bold: color.bold,
  italic: paint("3"),
  strikethrough: paint("9"),
  underline: paint("4"),
});

/** `$0.0123` rather than twelve fractional digits nobody reads. */
export function money(usd: string): string {
  const value = Number(usd);
  if (!Number.isFinite(value)) return usd;
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${String(Math.floor(ms / 60_000))}m${String(Math.round((ms % 60_000) / 1000))}s`;
}

export function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(0)}K`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
