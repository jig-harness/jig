/**
 * The excerpt of a run's transcript copy (`transcript-copy.ts`) the
 * steward's digest carries, at most `EXCERPT_BYTES` as JSON: the run's last
 * assistant turns and every tool error after its last successful tool call.
 * It is the run's own output, evidence for the steward to read and never
 * instructions to follow (`untrusted`).
 *
 * It reads both vendors' line shapes. Claude Code: an `assistant` line's
 * `message.content` holds `text` and `tool_use` items, and a `user` line's
 * holds each `tool_result`, an error with `is_error`. Codex: a
 * `response_item` line's `payload` is an assistant `message` of
 * `output_text` items, a `function_call` or `custom_tool_call`, or its
 * output, an error when its exit code is not zero. A line of another shape
 * is passed over.
 */
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";

/** The most bytes an excerpt takes in the digest, as JSON. */
export const EXCERPT_BYTES = 64 * 1024;
/** The most characters of one turn or one tool error an excerpt keeps: its end. */
const ITEM_CHARS = 8000;
/** The share of the excerpt tool errors may take, the newest kept. */
const ERROR_BYTES = 24 * 1024;

export interface ToolError {
  /** The tool's name, where the transcript names it. */
  tool: string | null;
  text: string;
}

export interface TranscriptExcerpt {
  untrusted: true;
  /** The run's last assistant turns, oldest first. */
  assistant: string[];
  /** Every tool error after the run's last successful tool call, oldest first. */
  toolErrors: ToolError[];
  /** Whether turns, errors or text were left out to keep within the bound. */
  cut: boolean;
}

interface ToolResult {
  ok: boolean;
  tool: string | null;
  text: string;
}

/** What the transcript holds, in order. */
interface Read {
  assistant: string[];
  results: ToolResult[];
}

/** The text of a content value: a string, or the text of each item of a list. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) =>
      isMapping(item) && typeof item.text === "string" ? item.text : "",
    )
    .filter((t) => t !== "")
    .join("\n");
}

function readClaude(
  line: Record<string, unknown>,
  read: Read,
  tools: Map<string, string>,
): void {
  const message = isMapping(line.message) ? line.message : null;
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const item of content) {
    if (isMapping(item)) readClaudeItem(line.type, item, read, tools);
  }
}

/** Interpret one content item after its envelope has been checked. */
function readClaudeItem(
  role: unknown,
  item: Record<string, unknown>,
  read: Read,
  tools: Map<string, string>,
): void {
  if (role === "assistant") {
    if (item.type === "text") read.assistant.push(textOf(item.text));
    else if (
      item.type === "tool_use" &&
      typeof item.id === "string" &&
      typeof item.name === "string"
    )
      tools.set(item.id, item.name);
    return;
  }
  if (role === "user" && item.type === "tool_result")
    read.results.push({
      ok: item.is_error !== true,
      tool:
        typeof item.tool_use_id === "string"
          ? (tools.get(item.tool_use_id) ?? null)
          : null,
      text: textOf(item.content),
    });
}

/** A Codex tool output's text and exit code, from its JSON form or its `Exit code:` line. */
function codexOutput(output: unknown): { text: string; code: number | null } {
  const text = textOf(output);
  try {
    const parsed: unknown = JSON.parse(text);
    if (isMapping(parsed)) {
      const meta = isMapping(parsed.metadata) ? parsed.metadata : {};
      return {
        text: textOf(parsed.output) || text,
        code:
          typeof parsed.exit_code === "number"
            ? parsed.exit_code
            : typeof meta.exit_code === "number"
              ? meta.exit_code
              : null,
      };
    }
  } catch (error) {
    swallow(error, "a Codex tool output in plain text");
  }
  const code = /^Exit code:\s*(-?\d+)/m.exec(text)?.[1];
  return { text, code: code === undefined ? null : Number(code) };
}

function readCodex(
  line: Record<string, unknown>,
  read: Read,
  tools: Map<string, string>,
): void {
  const p = isMapping(line.payload) ? line.payload : null;
  if (line.type !== "response_item" || p === null) return;
  if (p.type === "message" && p.role === "assistant")
    read.assistant.push(textOf(p.content));
  else if (
    (p.type === "function_call" || p.type === "custom_tool_call") &&
    typeof p.call_id === "string" &&
    typeof p.name === "string"
  )
    tools.set(p.call_id, p.name);
  else if (
    p.type === "function_call_output" ||
    p.type === "custom_tool_call_output"
  ) {
    const { text, code } = codexOutput(p.output);
    read.results.push({
      ok: code === 0,
      tool:
        typeof p.call_id === "string" ? (tools.get(p.call_id) ?? null) : null,
      text,
    });
  }
}

function readTranscript(text: string): Read {
  const read: Read = { assistant: [], results: [] };
  const tools = new Map<string, string>();
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch (error) {
      swallow(error, "a transcript line that does not read is passed over");
      continue;
    }
    if (!isMapping(line)) continue;
    readClaude(line, read, tools);
    readCodex(line, read, tools);
  }
  read.assistant = read.assistant.filter((t) => t.trim() !== "");
  return read;
}

/** The end of `text`, at most `ITEM_CHARS`, and whether it was cut. */
function ending(text: string): { text: string; cut: boolean } {
  const chars = [...text];
  return chars.length <= ITEM_CHARS
    ? { text, cut: false }
    : { text: `…${chars.slice(-ITEM_CHARS + 1).join("")}`, cut: true };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** The newest of `items` that fit in `budget` bytes, oldest first, and whether any were left out. */
function newestWithin<T>(
  items: T[],
  budget: number,
): { kept: T[]; dropped: boolean } {
  const kept: T[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as T;
    const size = bytes(item) + 1;
    if (used + size > budget) return { kept: kept.reverse(), dropped: true };
    used += size;
    kept.push(item);
  }
  return { kept: kept.reverse(), dropped: false };
}

/** The excerpt of a transcript copy's text. */
export function transcriptExcerpt(text: string): TranscriptExcerpt {
  const read = readTranscript(text);
  let lastOk = -1;
  read.results.forEach((r, i) => {
    if (r.ok) lastOk = i;
  });
  let cut = false;
  const errors = read.results.slice(lastOk + 1).map((r) => {
    const end = ending(r.text);
    cut ||= end.cut;
    return { tool: r.tool, text: end.text };
  });
  const turns = read.assistant.map((t) => {
    const end = ending(t);
    cut ||= end.cut;
    return end.text;
  });
  const empty: TranscriptExcerpt = {
    untrusted: true,
    assistant: [],
    toolErrors: [],
    cut: false,
  };
  const frame = bytes(empty) + 16;
  const kept = newestWithin(errors, ERROR_BYTES);
  const room = EXCERPT_BYTES - frame - bytes(kept.kept);
  const said = newestWithin(turns, room);
  return {
    untrusted: true,
    assistant: said.kept,
    toolErrors: kept.kept,
    cut: cut || kept.dropped || said.dropped,
  };
}
