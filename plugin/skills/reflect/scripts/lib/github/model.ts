/**
 * What the GitHub store keeps in a repository: one issue per change, the
 * comments a reflection adds to it, and the issue's title and description
 * recomputed from the events.
 *
 * The events are the record; everything else here is a view of them. A
 * store comment opens with `COMMENT_MARK` and holds each event as one line
 * in a fenced code block whose info string is `RECORD_INFO`, inside a
 * collapsed *Record* section. The prose beside the records is quoted, so no
 * line of it can open a record, and `@` and `#` in it are kept from
 * mentioning people or linking issues.
 */
import {
  type ComputedState,
  type DecisionEvent,
  type FindingEvent,
  highestSeverity,
  type ReflectionEvent,
  type Session,
  targetLabel,
} from "../events.ts";
import { changeEvents, changeTitle, decisionPlaces } from "../change-view.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { pageStatus, sessionLine } from "../notion/model.ts";
import { GitHubApiError } from "./api.ts";

/** The label every store issue carries, and `list` reads by. */
export const STORE_LABEL = "jig-reflection";

/** What `check`'s fix creates the label with. */
export const LABEL_DESCRIPTION =
  "Agent reflections kept by Jig's reflect skill";
export const LABEL_COLOR = "5319e7";

/** The first line of every comment that holds events. */
export const COMMENT_MARK = "<!-- jig-reflection-events -->";

/** The change of the issue that holds decisions about findings it lacks. */
export const UNFILED_KEY = "(decisions about findings this store lacks)";

/** The info string of the code block that holds one event. */
export const RECORD_INFO = "json jig-reflection-event";

const CHANGE_MARK = /^<!-- jig-reflection-change: (\S+) -->$/m;

/**
 * GitHub takes a comment or a description of at most 65,536 characters; a
 * body stays under this many bytes, which is never more characters.
 */
export const MAX_BODY_BYTES = 65_000;

/** GitHub's limit on an issue title, in characters. */
const MAX_TITLE = 256;

const bytes = (text: string): number => Buffer.byteLength(text);

// ── Prose ───────────────────────────────────────────────────────────────────

/** Text that mentions nobody and links nothing: `@` and `#` are broken up. */
export function quiet(text: string): string {
  return text.replace(/([@#])/g, "$1​");
}

/** Text on one line, quiet. */
function oneLine(text: string): string {
  return quiet(text.replace(/\s+/g, " ").trim());
}

/** Text as a block quote, so no line of it can open a code block. */
function quoted(text: string): string {
  return text
    .split(/\r?\n|\r/)
    .map((line) => `> ${quiet(line)}`.trimEnd())
    .join("\n");
}

/** A table cell: one line, pipes escaped. */
function cell(text: string): string {
  return oneLine(text).replaceAll("|", "\\|");
}

// ── Records ─────────────────────────────────────────────────────────────────

const FENCE = "```";

/**
 * An event's record: a collapsed section holding its line verbatim. The
 * line is a JSON object, so it never starts with the backticks that would
 * close the block.
 */
export function recordMarkdown(text: string): string {
  return [
    "<details><summary>Record</summary>",
    "",
    `${FENCE}${RECORD_INFO}`,
    text,
    FENCE,
    "",
    "</details>",
  ].join("\n");
}

/** Whether a comment is one the store wrote: it opens with `COMMENT_MARK`. */
export function isStoreComment(body: string): boolean {
  return (body.split("\n")[0] ?? "").trim() === COMMENT_MARK;
}

/**
 * The event lines in a comment, in order; null when the comment is not a
 * store comment. Throws when a record is not closed on the line after its
 * event, since a record cut short cannot be read whole.
 */
export function recordsIn(body: string): string[] | null {
  if (!isStoreComment(body)) return null;
  const lines = body.split("\n").map((line) => line.replace(/\r$/, ""));
  const texts: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const open = /^(`{3,})(.*)$/.exec(lines[i] as string);
    if (open === null || open[2] !== RECORD_INFO) continue;
    const text = lines[i + 1];
    if (text === undefined || lines[i + 2] !== open[1])
      throw new GitHubApiError(
        `a record on line ${i + 1} is not closed on the line after its event`,
      );
    texts.push(text);
    i += 2;
  }
  return texts;
}

// ── Comments ────────────────────────────────────────────────────────────────

function findingProse(finding: FindingEvent): string {
  return [
    `**${oneLine(finding.title)}** (${finding.severity} ${finding.kind} · ${oneLine(finding.class)} · ${oneLine(targetLabel(finding.target))})`,
    "",
    quoted(finding.description),
    "",
    "**Suggested fix:**",
    "",
    quoted(finding.suggested_fix),
  ].join("\n");
}

function decisionProse(decision: DecisionEvent): string {
  const where = decisionPlaces(decision, "");
  return [
    `**Review: ${decision.decision}** of finding \`${decision.finding}\` (${decision.at}${where.length === 0 ? "" : `; ${oneLine(where.join(", "))}`})`,
    "",
    quoted(decision.reason),
  ].join("\n");
}

function proseOf(event: ReflectionEvent): string {
  return event.type === "finding" ? findingProse(event) : decisionProse(event);
}

/** The shortest prose an event is shown with: its first line, shortened. */
function shortProse(event: ReflectionEvent): string {
  const title =
    event.type === "finding" ? event.title : `Review: ${event.decision}`;
  return `**${oneLine(title).slice(0, 200)}** (shortened: the record holds it whole)`;
}

function heading(stamp: string): string {
  return `${COMMENT_MARK}\n### Reflected ${stamp.slice(0, 10)} ${stamp.slice(11, 16)} UTC`;
}

function sessionQuote(session: Session): string {
  return quoted(sessionLine(session));
}

export interface Comment {
  body: string;
  /** The texts of the events it holds, in order. */
  texts: string[];
}

/**
 * The comments one append adds to an issue: each event's prose and record,
 * as many to a comment as fit. An event whose record alone does not fit in
 * one comment is refused.
 */
export function commentsFor(
  lines: ReadonlyArray<{ event: ReflectionEvent; text: string }>,
  stamp: string,
): Comment[] {
  const comments: Comment[] = [];
  let parts: string[] = [];
  let texts: string[] = [];
  let session: string | null = null;
  const fits = (candidate: readonly string[]) =>
    bytes(candidate.join("\n\n")) <= MAX_BODY_BYTES;
  for (const { event, text } of lines) {
    const record = recordMarkdown(text);
    const shown = JSON.stringify(event.session);
    const added = [
      ...(shown === session ? [] : [sessionQuote(event.session)]),
      proseOf(event),
      record,
    ];
    if (texts.length > 0 && fits([...parts, ...added])) {
      parts.push(...added);
      texts.push(text);
      session = shown;
      continue;
    }
    if (texts.length > 0) comments.push({ body: parts.join("\n\n"), texts });
    // A new comment, with the prose shortened when the whole does not fit.
    const fresh = [proseOf(event), shortProse(event)]
      .map((prose) => [
        heading(stamp),
        sessionQuote(event.session),
        prose,
        record,
      ])
      .find(fits);
    if (fresh === undefined)
      throw new GitHubApiError(
        `event ${event.id} is too long to keep in one GitHub comment`,
      );
    parts = fresh;
    texts = [text];
    session = shown;
  }
  if (texts.length > 0) comments.push({ body: parts.join("\n\n"), texts });
  return comments;
}

// ── The issue ───────────────────────────────────────────────────────────────

/** The change key an issue's description names, or null. */
export function keyInBody(body: string): string | null {
  const encoded = CHANGE_MARK.exec(body)?.[1];
  if (encoded === undefined) return null;
  try {
    return decodeURIComponent(encoded);
  } catch (error) {
    // A mark a person garbled: the issue's findings name its change instead.
    swallow(error, "an issue's change mark is not percent-encoded");
    return null;
  }
}

function changeMark(key: string): string {
  return `<!-- jig-reflection-change: ${encodeURIComponent(key)} -->`;
}

export interface IssueView {
  title: string;
  body: string;
}

function distinct(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

const VIEW_NOTE =
  "Agent reflections about one change, recorded by Jig's reflect skill. The JSON records in the comments below are what the skills read; this description is recomputed from them after every write, so an edit to it is replaced. Discuss a finding in a comment.";

type Row = [string, string | null | undefined];

/** The pull request the latest finding that names one names. */
function latestPullRequest(findings: readonly FindingEvent[]): string | null {
  const named = findings.findLast((f) => f.change.pull_request !== null);
  return named === undefined ? null : String(named.change.pull_request);
}

/** Where the latest finding's change is. */
function changeRows(latest: FindingEvent | undefined): Row[] {
  const change = latest?.change;
  return [
    ["Repository", change?.repository],
    ["Issue", change?.issue],
    ["Branch", change?.branch],
  ];
}

/** The latest finding's session. */
function sessionRows(latest: FindingEvent | undefined): Row[] {
  const session = latest?.session;
  return [
    ["Harness", session?.harness?.name],
    ["Model", session?.model],
    ["Jig version", session?.jig_version],
  ];
}

/** The summary table's rows, in the order shown. */
function summaryRows(
  status: string,
  events: readonly ReflectionEvent[],
  findings: readonly FindingEvent[],
): Row[] {
  const ats = events
    .map((event) => event.at)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    ["Status", status],
    ["Severity", highestSeverity(findings.map((f) => f.severity))],
    ["Classes", distinct(findings.map((f) => f.class)).join(", ")],
    [
      "Components",
      distinct(findings.map((f) => targetLabel(f.target))).join(", "),
    ],
    ...changeRows(findings.at(-1)),
    ["Pull request", latestPullRequest(findings)],
    ["Skills", distinct(findings.flatMap((f) => f.session.skills)).join(", ")],
    ...sessionRows(findings.at(-1)),
    ["First reflected", ats[0]],
    ["Last reflected", ats.at(-1)],
  ];
}

function tableLines(rows: readonly Row[]): string[] {
  return rows
    .filter((row): row is [string, string] => Boolean(row[1]))
    .map(([name, value]) => `| ${name} | ${cell(value)} |`);
}

function findingLine(finding: FindingEvent, state: ComputedState): string {
  const status = state.findings.get(finding.id)?.status ?? "open";
  return `- ${status} · ${finding.severity} ${finding.kind} · ${oneLine(finding.class)}: ${oneLine(finding.title)}\n`;
}

/** A line per finding, as many as the description has room for. */
function findingList(
  head: string,
  findings: readonly FindingEvent[],
  state: ComputedState,
): string {
  if (findings.length === 0) return `${head}- none: only decisions\n`;
  let body = head;
  for (const [index, finding] of findings.entries()) {
    const line = findingLine(finding, state);
    const more = `- …and ${findings.length - index} more; the comments hold them all\n`;
    if (bytes(body + line + more) > MAX_BODY_BYTES) return body + more;
    body += line;
  }
  return body;
}

/**
 * An issue's title and description, computed from its events read against
 * the state of the whole store.
 */
export function issueView(
  key: string,
  events: readonly ReflectionEvent[],
  state: ComputedState,
): IssueView {
  const { findings, decisions } = changeEvents(events);
  const status = pageStatus(
    findings.map((finding) => finding.id),
    decisions,
    state,
  );
  const head = [
    changeMark(key),
    VIEW_NOTE,
    "",
    "| | |",
    "|---|---|",
    ...tableLines(summaryRows(status, events, findings)),
    "",
    "**Findings**",
    "",
  ].join("\n");
  return {
    title: changeTitle(key, findings[0])
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TITLE),
    body: findingList(head, findings, state).trimEnd(),
  };
}
