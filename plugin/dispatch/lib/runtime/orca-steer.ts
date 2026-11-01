/**
 * `steer` on Orca: a nudge's text typed into the agent's terminal, with
 * Enter, after the checks the design asks for are read afresh in the same
 * call:
 *
 * 1. the terminal: `orca terminal list` names each terminal's tab and pane,
 *    and an agent's id in `orca worktree ps` is `<tabId>:<leafId>`, so the
 *    agent's terminal handle is the one whose tab and pane make its id;
 * 2. the agent still waits, and nobody is attached: `orca worktree ps`
 *    reports the agent's state, and marks the workspace a person has open
 *    in Orca (`isActive`), the nearest Orca comes to reporting attachment;
 * 3. the screen: `orca terminal read --screen` returns the rendered
 *    screen, which must show the agent's input prompt with an empty input
 *    line, no menu or question, and no text in Orca's composer (`draft`);
 * 4. the send: `orca terminal send --text <nudge> --enter`.
 *
 * A check that fails, or a read that does not answer in time, sends
 * nothing (`ok: false`). Once the send is called, an answer that is not a
 * clean acceptance is lost (`lost: true`): it may have typed. Neither Orca
 * nor a terminal offers a send that fails when the screen changed, so a
 * window remains between the screen read and the keystrokes.
 */
import { orcaCommand, orcaEnvelope } from "../../../shared/orca.ts";
import { isRecord } from "../../../shared/guards.ts";
import { run } from "../../../shared/proc.ts";
import { type RuntimeReceipt, WAITING_STATES } from "./port.ts";

const ROW_LIMIT = 2000;

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

type Answer =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; lost: boolean; why: string };

async function call(args: string[], timeoutMs: number): Promise<Answer> {
  const done = await run(
    [orcaCommand(process.env) ?? "orca", ...args, "--json"],
    { timeoutSec: seconds(timeoutMs), stderr: "pipe" },
  );
  const what = `orca ${args.slice(0, 2).join(" ")}`;
  if (done.timedOut)
    return {
      ok: false,
      lost: true,
      why: `${what} gave no answer within ${seconds(timeoutMs)}s`,
    };
  const envelope = orcaEnvelope(done.stdout);
  if (done.code === 0 && envelope?.ok === true && isRecord(envelope.result))
    return { ok: true, result: envelope.result };
  return {
    ok: false,
    lost: envelope === null,
    why: `${what} failed (exit ${done.code}): ${(done.stderr || done.stdout).trim().slice(0, 200)}`,
  };
}

/** An input box's top or bottom boundary: a rule of box-drawing characters, with or without corners, and nothing else (a draft's own `---` is not one). */
const BOUNDARY = /^\s*[╭┌╰└]?[─━═]{3,}[╮┐╯┘]?\s*$/;
/** The agent's input marker alone on its line. */
const MARKER = /^[>❯]$/;
/** What a menu or a question looks like on an agent's screen. */
const MENU =
  /^\s*[❯>]\s*\d+[.)]\s|\(y\/n\)|\[y\/n\]|esc to cancel|enter to (confirm|select)|do you want|would you like/i;
/** How many of the screen's last lines the input box must be among. */
const PROMPT_ZONE = 10;

/** One input line without its box border: a border is a `│` at both ends, and a lone `│` or `|` is the person's text. */
function unframed(line: string): string {
  const t = line.trim();
  return t.length >= 2 && t.startsWith("│") && t.endsWith("│")
    ? t.slice(1, -1).trim()
    : t;
}

/**
 * Why a rendered screen is not an agent waiting at an empty input line;
 * `null` when it is.
 *
 * The input box is what lies between the screen's two boundary lines, and
 * the check needs exactly two on the whole screen, both among the last lines:
 * draft text can look like a boundary, and a boundary above the last lines
 * can be a draft's own opening, so a screen with more cannot say where the
 * box begins and is refused, not guessed at. The box is ready only when its one non-empty line
 * is the bare input marker; whatever else it holds is draft text.
 */
export function screenNotReady(lines: readonly string[]): string | null {
  const shown = lines.map((l) => l.replace(/\s+$/, ""));
  while (shown.length > 0 && shown.at(-1) === "") shown.pop();
  if (shown.some((l) => MENU.test(l)))
    return "a menu or a question is on the screen";
  const all = shown.flatMap((l, i) => (BOUNDARY.test(l) ? [i] : []));
  if (all.length > 2)
    return "the screen shows more than one input box boundary pair";
  const offset = Math.max(0, shown.length - PROMPT_ZONE);
  const zone = shown.slice(offset);
  const edges = all.map((i) => i - offset);
  if (edges.length < 2 || (edges[0] as number) < 0)
    return "the screen shows no input prompt";
  const box = zone
    .slice((edges[0] as number) + 1, edges[1])
    .map(unframed)
    .filter((l) => l !== "");
  if (box.length === 0) return "the screen shows no input prompt";
  if (box.length > 1) return "the input box holds text below its first line";
  const only = box[0] as string;
  if (MARKER.test(only)) return null;
  return /^[>❯]\s/.test(only)
    ? "the input line holds text"
    : "the screen shows no input prompt";
}

/** The terminal whose tab and pane make the agent id `session`. */
function terminalOf(
  listing: Record<string, unknown>,
  session: string,
): { handle: string; path: string } | string {
  const scope = listing.hostScope;
  if (
    !isRecord(scope) ||
    !Array.isArray(scope.omittedHostIds) ||
    scope.omittedHostIds.length > 0
  )
    return "orca terminal list does not cover every host";
  const terminals = Array.isArray(listing.terminals) ? listing.terminals : [];
  const found = terminals
    .filter(isRecord)
    .find((t) => `${String(t.tabId)}:${String(t.leafId)}` === session);
  if (found === undefined || typeof found.handle !== "string")
    return `no terminal of Orca's is the agent ${session}`;
  if (found.writable === false)
    return `the terminal ${found.handle} is not writable`;
  return {
    handle: found.handle,
    path: typeof found.worktreePath === "string" ? found.worktreePath : "",
  };
}

/** Why the agent's workspace row says not to type: it no longer waits, or a person has it open. */
function rowBlocks(
  ps: Record<string, unknown>,
  path: string,
  session: string,
): string | null {
  const rows = Array.isArray(ps.worktrees) ? ps.worktrees.filter(isRecord) : [];
  const row = rows.find((w) => w.path === path);
  if (row === undefined)
    return `orca worktree ps does not list the workspace ${path}`;
  if (row.isActive === true)
    return `a person has the workspace ${path} open in Orca`;
  const agents = Array.isArray(row.agents) ? row.agents.filter(isRecord) : [];
  const agent = agents.find((a) => a.paneKey === session);
  if (agent === undefined)
    return `orca worktree ps no longer lists the agent ${session}`;
  return typeof agent.state === "string" && WAITING_STATES.has(agent.state)
    ? null
    : `the agent is ${String(agent.state)}, not waiting`;
}

/** Why the screen read says not to type; `null` when it shows an empty input line. */
function screenBlocks(result: Record<string, unknown>): string | null {
  const terminal = isRecord(result.terminal) ? result.terminal : {};
  if (terminal.source !== "screen")
    return `the rendered screen could not be read (source ${String(terminal.source ?? "absent")})`;
  if (typeof terminal.draft === "string" && terminal.draft.trim() !== "")
    return "Orca's composer holds a draft";
  const tail = Array.isArray(terminal.tail) ? terminal.tail : null;
  if (tail === null || !tail.every((l) => typeof l === "string"))
    return "the screen read returned no lines";
  return screenNotReady(tail as string[]);
}

const refuse = (detail: string): RuntimeReceipt => ({ ok: false, detail });

export async function orcaSteer(
  session: string,
  text: string,
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  const listing = await call(
    ["terminal", "list", "--limit", String(ROW_LIMIT)],
    timeoutMs,
  );
  if (!listing.ok) return refuse(`nothing sent: ${listing.why}`);
  const terminal = terminalOf(listing.result, session);
  if (typeof terminal === "string") return refuse(`nothing sent: ${terminal}`);
  const ps = await call(
    ["worktree", "ps", "--limit", String(ROW_LIMIT)],
    timeoutMs,
  );
  if (!ps.ok) return refuse(`nothing sent: ${ps.why}`);
  const row = rowBlocks(ps.result, terminal.path, session);
  if (row !== null) return refuse(`nothing sent: ${row}`);
  const screen = await call(
    ["terminal", "read", "--terminal", terminal.handle, "--screen"],
    timeoutMs,
  );
  if (!screen.ok) return refuse(`nothing sent: ${screen.why}`);
  const shown = screenBlocks(screen.result);
  if (shown !== null) return refuse(`nothing sent: ${shown}`);
  const sent = await call(
    [
      "terminal",
      "send",
      "--terminal",
      terminal.handle,
      "--text",
      text,
      "--enter",
    ],
    timeoutMs,
  );
  return sent.ok
    ? {
        ok: true,
        detail: `typed into ${terminal.handle}: ${JSON.stringify(sent.result).slice(0, 200)}`,
      }
    : {
        ok: false,
        lost: true,
        detail: `the send to ${terminal.handle} is not known to have arrived: ${sent.why}`,
      };
}
