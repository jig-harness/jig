/**
 * What the Notion store keeps in a database: its properties, the blocks a
 * reflection adds to a change's page, and the page properties recomputed
 * from the events.
 *
 * The events are the record; everything else here is a view of them. Each
 * event is a code block, captioned with `EVENT_CAPTION`, inside a collapsed
 * toggle. The prose beside it and the page's properties can be edited by
 * people without changing what the skills read.
 */
import { createHash } from "node:crypto";
import { isMapping } from "../../../../resolve-review-comments/scripts/lib/config-layers.ts";
import {
  type ComputedState,
  type DecisionEvent,
  type FindingEvent,
  highestSeverity,
  type ReflectionEvent,
  type Session,
  type Status,
  targetLabel,
} from "../events.ts";

/** In the database's description: the mark of a database `init` created. */
export const STORE_MARK = "jig-reflection-store/1";

/** The caption of every code block that holds an event. */
export const EVENT_CAPTION = "jig reflection event";

/** The title of the page that holds decisions about findings it lacks. */
export const UNFILED_KEY = "(decisions about findings this database lacks)";

export const PROPERTY = {
  name: "Name",
  status: "Status",
  computed: "Computed status",
  digest: "Computed properties",
  key: "Change key",
  severity: "Severity",
  classes: "Classes",
  components: "Components",
  repository: "Repository",
  issue: "Issue",
  branch: "Branch",
  pullRequest: "Pull request",
  skills: "Skills",
  harness: "Harness",
  model: "Model",
  jigVersion: "Jig version",
  sessions: "Sessions",
  first: "First reflected",
  last: "Last reflected",
} as const;

/** Properties the store writes and no view shows. */
export const HIDDEN_PROPERTIES = [
  PROPERTY.computed,
  PROPERTY.digest,
  PROPERTY.key,
];

export const STATUS_LABELS = [
  "Inbox",
  "Approved",
  "Implemented",
  "Deferred",
  "Dismissed",
  "Escalated",
] as const;
export type StatusLabel = (typeof STATUS_LABELS)[number];

const STATUS_COLORS: Record<StatusLabel, string> = {
  Inbox: "blue",
  Approved: "yellow",
  Implemented: "green",
  Deferred: "gray",
  Dismissed: "brown",
  Escalated: "red",
};

const SEVERITY_LABELS = { high: "High", medium: "Medium", low: "Low" };

/** Each property's type, as `init` creates it and `check` expects it. */
export const PROPERTY_TYPES: Record<string, string> = {
  [PROPERTY.name]: "title",
  [PROPERTY.status]: "select",
  [PROPERTY.computed]: "rich_text",
  [PROPERTY.digest]: "rich_text",
  [PROPERTY.key]: "rich_text",
  [PROPERTY.severity]: "select",
  [PROPERTY.classes]: "multi_select",
  [PROPERTY.components]: "multi_select",
  [PROPERTY.repository]: "select",
  [PROPERTY.issue]: "rich_text",
  [PROPERTY.branch]: "rich_text",
  [PROPERTY.pullRequest]: "number",
  [PROPERTY.skills]: "multi_select",
  [PROPERTY.harness]: "select",
  [PROPERTY.model]: "select",
  [PROPERTY.jigVersion]: "select",
  [PROPERTY.sessions]: "number",
  [PROPERTY.first]: "date",
  [PROPERTY.last]: "date",
};

/** The property definitions `init` creates the database with. */
export function propertySchema(): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(PROPERTY_TYPES)) {
    let config: Record<string, unknown> = {};
    if (name === PROPERTY.status)
      config = {
        options: STATUS_LABELS.map((label) => ({
          name: label,
          color: STATUS_COLORS[label],
        })),
      };
    else if (name === PROPERTY.severity)
      config = {
        options: [
          { name: "High", color: "red" },
          { name: "Medium", color: "orange" },
          { name: "Low", color: "gray" },
        ],
      };
    else if (type === "number") config = { format: "number" };
    schema[name] = { type, [type]: config };
  }
  return schema;
}

// ── Rich text ───────────────────────────────────────────────────────────────

/** Notion's limit is 2000 characters a text object; this stays under it. */
const CHUNK = 1800;
/** Notion's limit on the items of one rich text array. */
const MAX_ITEMS = 100;

/** Split text into pieces of at most `CHUNK` units, never inside a character. */
function chunks(text: string): string[] {
  const pieces: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + CHUNK, text.length);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    pieces.push(text.slice(at, end));
    at = end;
  }
  return pieces;
}

export interface RichTextItem {
  type: "text";
  text: { content: string };
  annotations?: Record<string, boolean>;
}

/** Text as rich text; null when it needs more items than Notion takes. */
export function exactRichText(text: string): RichTextItem[] | null {
  const pieces = chunks(text);
  if (pieces.length > MAX_ITEMS) return null;
  return pieces.map((content) => ({ type: "text", text: { content } }));
}

/** Text as rich text for people to read: shortened when too long. */
export function richText(text: string, bold = false): RichTextItem[] {
  const pieces = chunks(text).slice(0, MAX_ITEMS);
  return pieces.map((content) => ({
    type: "text",
    text: { content },
    ...(bold ? { annotations: { bold: true } } : {}),
  }));
}

/** The plain text of a rich text array as the API returns it. */
export function plainText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) =>
      isMapping(item) && typeof item.plain_text === "string"
        ? item.plain_text
        : isMapping(item) &&
            isMapping(item.text) &&
            typeof item.text.content === "string"
          ? item.text.content
          : "",
    )
    .join("");
}

// ── Blocks ──────────────────────────────────────────────────────────────────

export type Block = Record<string, unknown>;

/** A paragraph of readable text, shortened to the items Notion takes. */
function paragraph(rich: RichTextItem[]): Block {
  return {
    type: "paragraph",
    paragraph: { rich_text: rich.slice(0, MAX_ITEMS) },
  };
}

/** The collapsed toggle that holds an event, or null when it is too long. */
export function recordBlock(text: string): Block | null {
  const rich = exactRichText(text);
  if (rich === null) return null;
  return {
    type: "toggle",
    toggle: {
      rich_text: richText("Record"),
      children: [
        {
          type: "code",
          code: {
            language: "json",
            caption: richText(EVENT_CAPTION),
            rich_text: rich,
          },
        },
      ],
    },
  };
}

export function sectionHeading(now: string): Block {
  const shown = `${now.slice(0, 10)} ${now.slice(11, 16)} UTC`;
  return {
    type: "heading_3",
    heading_3: { rich_text: richText(`Reflected ${shown}`) },
  };
}

export function sessionLine(session: Session): string {
  const harness = session.harness;
  const parts = [
    `Harness: ${harness === null ? "unknown" : [harness.name ?? "unknown", harness.version].filter(Boolean).join(" ")}`,
    `Model: ${session.model ?? "unknown"}`,
    `Jig: ${session.jig_version ?? "unknown"}`,
    `Skills: ${session.skills.length === 0 ? "none" : session.skills.join(", ")}`,
  ];
  if (session.mode !== null) parts.push(`Mode: ${session.mode}`);
  return parts.join(" · ");
}

export function sessionCallout(session: Session): Block {
  return {
    type: "callout",
    callout: { rich_text: richText(sessionLine(session)) },
  };
}

/** A finding as people read it; its record follows. */
export function findingBlocks(finding: FindingEvent): Block[] {
  const about = ` (${finding.severity} ${finding.kind} · ${finding.class} · ${targetLabel(finding.target)})`;
  return [
    paragraph([...richText(finding.title, true), ...richText(about)]),
    paragraph(richText(finding.description)),
    paragraph([
      ...richText("Suggested fix: ", true),
      ...richText(finding.suggested_fix),
    ]),
  ];
}

/** A decision as a review note under its finding; its record follows. */
export function decisionBlocks(decision: DecisionEvent): Block[] {
  const where = [
    decision.commit === undefined ? null : `commit ${decision.commit}`,
    decision.pull_request === undefined
      ? null
      : `pull request #${decision.pull_request}`,
    decision.issue === undefined ? null : `issue ${decision.issue}`,
  ].filter((part) => part !== null);
  return [
    paragraph([
      ...richText(`Review: ${decision.decision}`, true),
      ...richText(
        ` (${decision.at}) ${decision.reason}${where.length === 0 ? "" : ` (${where.join(", ")})`}`,
      ),
    ]),
  ];
}

// ── Pages and properties ────────────────────────────────────────────────────

/** Which change a finding belongs to: its issue key, else its branch. */
export function changeKey(finding: FindingEvent): string {
  const change = finding.change;
  const what =
    change.issue !== null
      ? `issue:${change.issue}`
      : `branch:${change.branch ?? "(no branch)"}`;
  return `${change.repository}#${what}`;
}

export function statusLabel(status: Status): StatusLabel {
  return status === "open"
    ? "Inbox"
    : ((status.charAt(0).toUpperCase() + status.slice(1)) as StatusLabel);
}

/**
 * A page's Status: Inbox while any finding on it has no decision, Approved
 * while any is approved but not yet merged, otherwise its latest decision.
 */
export function pageStatus(
  findingIds: readonly string[],
  decisions: readonly DecisionEvent[],
  state: ComputedState,
): StatusLabel {
  const held = findingIds
    .map((id) => state.findings.get(id))
    .filter((finding) => finding !== undefined);
  if (held.some((finding) => finding.status === "open")) return "Inbox";
  if (held.some((finding) => finding.status === "approved")) return "Approved";
  const latest = [
    ...held.flatMap((finding) =>
      finding.latest === null ? [] : [finding.latest],
    ),
    // A decision about a finding the store lacks still says something.
    ...decisions.filter((decision) => !state.findings.has(decision.finding)),
  ].sort((a, b) =>
    a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.id < b.id ? 1 : -1,
  )[0];
  return latest === undefined ? "Inbox" : statusLabel(latest.decision);
}

/** A select option's name: Notion refuses commas and long names. */
function option(value: string | null | undefined): { name: string } | null {
  if (value === null || value === undefined) return null;
  const name = value.replaceAll(",", ";").trim().slice(0, 100);
  return name === "" ? null : { name };
}

/** Notion's limit on the options of one multi-select value. */
const MAX_OPTIONS = 100;

/** Distinct options, the first hundred: the events keep the rest. */
function options(values: Iterable<string>): Array<{ name: string }> {
  const seen = new Map<string, { name: string }>();
  for (const value of values) {
    const held = option(value);
    if (held !== null) seen.set(held.name, held);
  }
  return [...seen.values()].slice(0, MAX_OPTIONS);
}

function textValue(value: string | null): { rich_text: RichTextItem[] } {
  return { rich_text: value === null ? [] : richText(value) };
}

function dateValue(at: string | undefined): { date: { start: string } | null } {
  return { date: at === undefined ? null : { start: at } };
}

/**
 * A session's setup as one string: harness, model, Jig version, skills (in
 * any order) and mode. Which of them the agent stated is provenance, not
 * setup, so it is left out.
 */
function sessionSetup(session: Session): string {
  const harness = session.harness;
  return JSON.stringify([
    harness === null
      ? null
      : [harness.name, harness.version, harness.entrypoint, harness.wrapper],
    session.model,
    session.jig_version,
    [...new Set(session.skills)].sort(),
    session.mode,
  ]);
}

/**
 * The properties of a change's page, computed from its events: the findings
 * and decisions it holds, read against the state of the whole store. Status
 * is left out: whether to write it is the hand-edit rule's call. `digest`
 * stands for all the others, and is written with them to the hidden
 * *Computed properties*, so a page whose properties are behind its events
 * can be told apart without reading them.
 */
export function pageProperties(
  key: string,
  events: readonly ReflectionEvent[],
  state: ComputedState,
): {
  properties: Record<string, unknown>;
  status: StatusLabel;
  digest: string;
} {
  const findings = events
    .filter((event): event is FindingEvent => event.type === "finding")
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const decisions = events.filter(
    (event): event is DecisionEvent => event.type === "decision",
  );
  const first = findings[0];
  const latest = findings.at(-1);
  const change = latest?.change;
  const title =
    first === undefined
      ? key
      : `[${first.change.repository}] ${first.change.issue ?? first.change.branch ?? "(no branch)"}: ${first.title}`;
  const sessions = new Set(
    [...findings, ...decisions].map((event) => sessionSetup(event.session)),
  );
  const pullRequest =
    [...findings].reverse().find((f) => f.change.pull_request !== null)?.change
      .pull_request ?? null;
  const severity = highestSeverity(findings.map((f) => f.severity));
  const ats = events.map((event) => event.at).sort();
  const status = pageStatus(
    findings.map((finding) => finding.id),
    decisions,
    state,
  );
  const properties: Record<string, unknown> = {
    [PROPERTY.name]: { title: richText(title) },
    [PROPERTY.computed]: textValue(status),
    [PROPERTY.key]: textValue(key),
    [PROPERTY.severity]: {
      select: severity === null ? null : { name: SEVERITY_LABELS[severity] },
    },
    [PROPERTY.classes]: {
      multi_select: options(findings.map((f) => f.class)),
    },
    [PROPERTY.components]: {
      multi_select: options(findings.map((f) => targetLabel(f.target))),
    },
    [PROPERTY.repository]: { select: option(change?.repository) },
    [PROPERTY.issue]: textValue(change?.issue ?? null),
    [PROPERTY.branch]: textValue(change?.branch ?? null),
    [PROPERTY.pullRequest]: { number: pullRequest },
    [PROPERTY.skills]: {
      multi_select: options(findings.flatMap((f) => f.session.skills)),
    },
    [PROPERTY.harness]: {
      select: option(latest?.session.harness?.name),
    },
    [PROPERTY.model]: { select: option(latest?.session.model) },
    [PROPERTY.jigVersion]: { select: option(latest?.session.jig_version) },
    [PROPERTY.sessions]: { number: sessions.size },
    [PROPERTY.first]: dateValue(ats[0]),
    [PROPERTY.last]: dateValue(ats.at(-1)),
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(properties))
    .digest("hex")
    .slice(0, 32);
  properties[PROPERTY.digest] = textValue(digest);
  return { status, properties, digest };
}

/** A page property's shown value: a select's name, or the text. */
export function shownValue(property: unknown): string | null {
  if (!isMapping(property)) return null;
  if (property.type === "select")
    return isMapping(property.select) &&
      typeof property.select.name === "string"
      ? property.select.name
      : null;
  if (property.type === "rich_text") {
    const text = plainText(property.rich_text);
    return text === "" ? null : text;
  }
  if (property.type === "title") {
    const text = plainText(property.title);
    return text === "" ? null : text;
  }
  return null;
}
