import type { ToolActivity } from "../session/index.js";
import { color } from "./theme.js";

/**
 * Turns a tool call into one readable line.
 *
 * The point is that the user can see what the agent actually did. Arguments are
 * parsed only to pick out the one field worth showing; the exact bytes stay in
 * the Journal and are never rebuilt from this.
 */
export function formatToolActivity(activity: ToolActivity): string {
  const subject = toolSubject(activity.name, activity.arguments);
  const head = `${color.tool("●")} ${color.bold(activity.name)}${subject === null ? "" : ` ${subject}`}`;
  if (activity.status === undefined) return head;
  if (activity.status === "succeeded") return head;
  const detail = activity.code === undefined ? activity.status : activity.code;
  return `${head}  ${color.error(detail)}`;
}

function toolSubject(name: string, argumentsJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const raw =
    name === "bash"
      ? record["command"]
      : name === "web_search"
        ? record["search_query"]
        : (record["path"] ?? record["file_path"]);
  if (typeof raw !== "string") return null;
  const oneLine = raw.split("\n")[0] ?? "";
  const trimmed = oneLine.length > 68 ? `${oneLine.slice(0, 67)}…` : oneLine;
  return color.dim(trimmed);
}
