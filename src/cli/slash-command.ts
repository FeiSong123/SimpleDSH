import type { SlashCommand } from "../tui/index.js";

/**
 * Decides whether an interactive submission that starts with "/" is a known
 * slash command rather than a prompt. Absolute paths (`/tmp/report.pdf`) and
 * path-prefixed sentences start with "/" too; only inputs whose first token
 * matches a declared command (or one of its aliases) are routed to the
 * command handler. Everything else stays an ordinary user prompt.
 */
export function isKnownSlashCommand(
  text: string,
  commands: readonly SlashCommand[],
  aliases: readonly string[] = [],
): boolean {
  const [name] = text.slice(1).split(/\s+/u);
  if (name === undefined || name.length === 0) return false;
  return (
    commands.some((command) => command.name === name) ||
    aliases.includes(name)
  );
}
