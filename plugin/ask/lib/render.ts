import { nextText } from "../../dispatch/lib/next-owner.ts";
/**
 * An answer printed for a person. A record's own words are printed with
 * their control characters removed, so a comment cannot move the cursor,
 * clear the screen or hide a line; they are shown as data, never acted on.
 */
import type {
  AskAnswer,
  Holder,
  Last,
  SourceRead,
  ThreadEntry,
  WaitsOn,
} from "./answer.ts";
import type { WaitingAnswer } from "./waiting.ts";

/** `text` with every control character replaced by a space. */
export function printable(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const control =
      c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
    out += control ? " " : ch;
  }
  return out;
}

function holderLines(holder: Holder | "none"): string[] {
  if (holder === "none") return ["none"];
  const head = [
    holder.stage,
    `on ${holder.host}`,
    holder.generation === null
      ? null
      : `driver generation ${holder.generation}`,
    `process ${holder.process}`,
  ]
    .filter((p): p is string => p !== null)
    .join(", ");
  const lines = [head, `(${holder.why})`];
  const local = holder.local;
  if (local !== undefined) {
    const parts = [
      local.account === undefined ? null : `account ${local.account}`,
      local.session === undefined ? null : `session ${local.session}`,
      local.record === undefined ? null : `launch record ${local.record}`,
      local.workspace === undefined ? null : `workspace ${local.workspace}`,
    ].filter((p): p is string => p !== null);
    if (parts.length > 0) lines.push(`${parts.join(", ")} (this machine's)`);
  }
  return lines;
}

function waitsLine(w: WaitsOn): string {
  if (w === "none") return "none";
  if ("waiting" in w) return `waiting: ${w.waiting}`;
  return `person: ${w.person} · ${w.needAct}${w.people?.length ? ` [${w.people.join(", ")}]` : ""} (${w.why})`;
}

function lastLine(last: Last | null): string {
  return last === null
    ? "none recorded"
    : `${last.class} at ${last.at}: ${last.reason} (from the ${last.from})`;
}

function sourceLine(s: SourceRead): string {
  const where = s.local === true ? " (this machine)" : "";
  return `${s.record}${where}: ${s.read ? "read" : "not read"}${s.detail === undefined ? "" : ` (${s.detail})`}`;
}

/** One thread entry as two lines: what it says, then the record it comes from. */
function entryLines(e: ThreadEntry): string[] {
  const where = e.record.url ?? e.record.path ?? "";
  const until = e.until === undefined ? "" : ` (off since ${e.until})`;
  const local = e.local ? " (this machine)" : "";
  return [
    printable(
      `    ${e.at}  ${e.kind.padEnd(8)} ${e.from} -> ${e.to}${local}: ${e.text}${until}`,
    ),
    `      ${e.record.kind}${where === "" ? "" : ` ${where}`}`,
  ];
}

/** The thread, and how many earlier entries its window left out. */
function threadLines(
  thread: readonly ThreadEntry[],
  omitted: number,
): string[] {
  const out = ["  thread"];
  if (thread.length === 0) out.push("    no entries");
  for (const e of thread) out.push(...entryLines(e));
  if (omitted > 0)
    out.push(
      `    ${omitted} earlier entr${omitted === 1 ? "y" : "ies"} left out; --since or --all shows them`,
    );
  return out;
}

/** The answer as lines a person reads. */
export function renderAnswer(a: AskAnswer): string {
  const field = (name: string, lines: string[]) =>
    lines.map((l, i) => `  ${(i === 0 ? name : "").padEnd(8)} ${printable(l)}`);
  const out = [
    `${a.address}${a.title === null ? "" : `  ${printable(a.title)}`}`,
    ...(a.url === null ? [] : [`  ${a.url}`]),
    ...field("holder", holderLines(a.holder)),
    ...field("state", [`${a.state}: ${a.stateDetail}`]),
    ...field("waitsOn", [waitsLine(a.waitsOn)]),
    ...field("last", [lastLine(a.last)]),
    ...(a.last === null
      ? []
      : field("last.next", [
          a.last.next == null ? "not recorded" : nextText(a.last.next),
        ])),
    ...field("sources", [
      ...a.sources.records.map(sourceLine),
      `forge calls ${a.sources.forgeCalls}, tracker calls ${a.sources.trackerCalls}`,
    ]),
  ];
  if (a.thread !== undefined)
    out.push(...threadLines(a.thread, a.threadOmitted ?? 0));
  return out.join("\n");
}

/** What waits on a person, as lines. */
export function renderWaiting(w: WaitingAnswer): string {
  if (w.tick === null) return w.unread ?? "there is no line to read";
  const head = `waiting on a person, as the tick ${w.tick.runId} found it at ${w.tick.finishedAt}:`;
  if (w.waiting.length === 0) return `${head}\n  nothing`;
  return [
    head,
    ...w.waiting.flatMap((e) => [
      printable(
        `  ${e.address}  ${e.act} · ${e.needAct}${e.people.length ? ` [${e.people.join(", ")}]` : ""}  since ${e.since}${e.title === null ? "" : `  ${e.title}`}`,
      ),
      printable(`    ${e.reason}`),
      ...e.questions.map((q) => printable(`    question: ${q}`)),
      ...(e.url === null ? [] : [`    ${e.url}`]),
    ]),
  ].join("\n");
}
