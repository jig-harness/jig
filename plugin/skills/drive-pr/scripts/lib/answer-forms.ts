/** One interpretation of a person's answer for every reader of parked work. */
import { createHash } from "node:crypto";
import { normalizeAnswerText } from "../../../../shared/decisions/answer-normalize.ts";
import {
  renderParkedDecision,
  type ParkedDecision,
} from "../../../../shared/decisions/park.ts";
import { TRUSTED_ASSOCIATIONS } from "../../../../shared/trusted-authors.ts";
import { redact, redactStrings } from "../../../../shared/redact.ts";
import { answerTextFault, withoutAnswerRecord } from "./answer-comment.ts";
import type { ParkedItem } from "./state/schema.ts";
import type { PendingAnswer, AnswerChoice } from "./state/pass-handoff.ts";
import { parseDecisionRecord } from "./state/framed-park.ts";
import { recordOptions, recordSteps } from "./state/park-frame.ts";

export interface CommentLike {
  author: string;
  association: string;
  at: string;
  editedAt?: string | null;
  url: string;
  body: string;
}

/** Edited comments are new answers; an unreadable edit time never falls back. */
export function answerTime(c: CommentLike): string {
  return c.editedAt ?? c.at;
}

/** The sole author and script-comment guard for answers. */
export function isAnswer(c: CommentLike, after: number): boolean {
  return (
    TRUSTED_ASSOCIATIONS.has(c.association) &&
    c.author !== "" &&
    Date.parse(answerTime(c)) > after &&
    !/^\*\*(accepted|rejected|wont-fix|deferred|moot)\*\*/.test(c.body) &&
    !withoutAnswerRecord(c.body).includes("<!--")
  );
}

/** Only lines outside fenced examples can address a parked key. */
export function linesOutsideFences(body: string): string[] {
  let fence = "";
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1] ?? "";
    if (fence === "") {
      if (marker !== "") fence = marker;
      else out.push(raw);
    } else if (
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      line.slice(marker.length).trim() === ""
    )
      fence = "";
  }
  return out;
}

function indented(raw: string): boolean {
  return /^( {4}|\t)/.test(raw.replace(/^ {0,3}(?=\t)/, ""));
}

/** Kept for callers that read historical free-answer lines. */
export function isAnswerLine(
  raw: string,
  line: string,
  prefix: string,
): boolean {
  return (
    !indented(raw) &&
    line.toLowerCase().startsWith(prefix) &&
    line.slice(prefix.length).trim() !== ""
  );
}

export function answersKey(body: string, key: string): boolean {
  const prefix = `answer ${key}:`.toLowerCase();
  return linesOutsideFences(body).some((raw) =>
    isAnswerLine(raw, raw.trim(), prefix),
  );
}

interface Line {
  kind: "answer" | "note";
  key: string;
  text: string;
}
function addressedLine(raw: string, knownKey?: string): Line | null {
  if (indented(raw)) return null;
  const m = /^(answer|note) (.+)$/i.exec(raw.trim());
  if (m === null) return null;
  const rest = m[2] ?? "";
  const delimiter =
    knownKey !== undefined &&
    rest.toLowerCase().startsWith(`${knownKey}:`.toLowerCase())
      ? knownKey.length
      : rest.lastIndexOf(":");
  const key = rest.slice(0, delimiter);
  const text = rest.slice(delimiter + 1).trimStart();
  return delimiter < 1 || /\s/.test(key) || !/^\S/.test(text)
    ? null
    : {
        kind: m[1]?.toLowerCase() as Line["kind"],
        key: key.toLowerCase(),
        text,
      };
}

/** Notification quotes are removed only when their exact text is known. */
function answerLines(item: ParkedItem, body: string): string[] {
  const known = new Set(
    [
      redact(item.reason),
      ...(item.decision === undefined
        ? []
        : renderParkedDecision(redactStrings(item.decision)).split("\n")),
      ...(item.record === undefined ? [] : redact(item.record).split("\n")),
    ]
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return withoutAnswerRecord(body)
    .replaceAll("\r", "")
    .split("\n")
    .filter((raw) => {
      const line = raw.trim();
      if (line === "") return false;
      if (indented(raw)) return true;
      const quote = /^>\s?(.*)$/.exec(line)?.[1];
      return quote === undefined || !known.has(quote.trim());
    });
}

/** Read keyed lines once, rejecting duplicates, prose and orphaned notes. */
function addressedAnswers(
  lines: string[],
  knownKey?: string,
): {
  answers: Map<string, string>;
  notes: Map<string, string>;
} | null {
  const answers = new Map<string, string>();
  const notes = new Map<string, string>();
  for (const raw of lines) {
    const line = addressedLine(raw, knownKey);
    if (line === null || answerTextFault(line.text) !== null) return null;
    const map = line.kind === "answer" ? answers : notes;
    if (map.has(line.key)) return null;
    map.set(line.key, line.text);
  }
  if ([...notes.keys()].some((k) => !answers.has(k))) return null;
  return { answers, notes };
}

/** Whole-comment grammar, narrowed to this item's single answer on a thread. */
function bareThreadText(
  lines: string[],
  key: string,
): { text: string; note?: string } | null {
  const first = lines[0] ?? "";
  const note = lines.length === 2 ? addressedLine(lines[1] ?? "", key) : null;
  if (
    (lines.length !== 1 &&
      (note?.kind !== "note" || note.key !== key.toLowerCase())) ||
    indented(first) ||
    addressedLine(first) !== null ||
    answerTextFault(first.trim()) !== null ||
    (note !== null && answerTextFault(note.text) !== null)
  )
    return null;
  return { text: first.trim(), ...(note === null ? {} : { note: note.text }) };
}

function structuredText(
  lines: string[],
  key: string,
  place: "thread" | "conversation",
): { text: string; note?: string } | null {
  const bare = place === "thread" ? bareThreadText(lines, key) : null;
  if (bare !== null) return bare;
  const keyed = addressedAnswers(lines, key);
  if (keyed === null) return null;
  const { answers, notes } = keyed;
  if (
    place === "thread" &&
    (answers.size !== 1 || !answers.has(key.toLowerCase()))
  )
    return null;
  const text = answers.get(key.toLowerCase());
  const note = notes.get(key.toLowerCase());
  return text === undefined
    ? null
    : { text, ...(note === undefined ? {} : { note }) };
}

function choiceOf(
  item: ParkedItem,
  text: string,
  note?: string,
): AnswerChoice | undefined {
  const call = answerDecision(item)?.call;
  if (call === undefined) return undefined;
  // Older parks predate the identity guard. Both private and public copies
  // stay free when redaction or normalization can hide which option is meant.
  if (
    call.options.some(
      (o) =>
        redact(o.name) !== o.name ||
        o.name.toLowerCase().includes("<redacted>"),
    )
  )
    return undefined;
  if (
    new Set(call.options.map((o) => normalizeAnswerText(o.name))).size !==
    call.options.length
  )
    return undefined;
  const normalized = normalizeAnswerText(text);
  const form =
    normalized === "approve"
      ? "approve"
      : normalized.startsWith("choose ")
        ? "choose"
        : null;
  if (form === null) return undefined;
  const options =
    form === "approve"
      ? call.options.filter((o) => o.id === call.recommended)
      : call.options.filter(
          (o) => normalizeAnswerText(o.name) === normalized.slice(7),
        );
  const option = options.length === 1 ? options[0] : undefined;
  return option === undefined
    ? undefined
    : {
        option: option.name,
        recommended: option.id === call.recommended,
        form,
        ...(note === undefined ? {} : { note }),
      };
}

export function parseAnswerComment(
  item: ParkedItem,
  c: CommentLike,
  place: "thread" | "conversation",
): PendingAnswer | null {
  if (item.at === undefined || !isAnswer(c, Date.parse(item.at))) return null;
  const lines = answerLines(item, c.body);
  if (lines.length === 0) return null;
  // A note by itself is not an answer, including on a review thread.
  if (lines.every((line) => addressedLine(line)?.kind === "note")) return null;
  if (
    place === "conversation" &&
    !answersKey(withoutAnswerRecord(c.body), item.key)
  )
    return null;
  const structured = structuredText(lines, item.key, place);
  const choice =
    structured === null
      ? undefined
      : choiceOf(item, structured.text, structured.note);
  return {
    author: c.author,
    at: answerTime(c),
    url: c.url,
    body: withoutAnswerRecord(c.body),
    bodyHash: createHash("sha256").update(c.body).digest("hex"),
    ...(choice === undefined ? {} : { choice }),
  };
}

/** A note cannot settle an item, but a reader can explain what the person left. */
export function noteWithoutAnswer(
  item: ParkedItem,
  c: CommentLike,
): string | null {
  if (item.at === undefined || !isAnswer(c, Date.parse(item.at))) return null;
  const lines = answerLines(item, c.body);
  if (lines.length !== 1) return null;
  const line = addressedLine(lines[0] ?? "");
  return line?.kind === "note" &&
    line.key === item.key.toLowerCase() &&
    answerTextFault(line.text) === null
    ? line.text
    : null;
}

/** Old framed records use the same checked legacy reader as their original park. */
export function answerDecision(item: ParkedItem): ParkedDecision | undefined {
  if (item.decision !== undefined) return item.decision;
  if (item.record === undefined || item.class === undefined) return undefined;
  const parsed = parseDecisionRecord(item.record, item.class);
  if ("problems" in parsed) return undefined;
  const r = parsed.record;
  const options = recordOptions(r.Options, r.Recommended).map((o, i) => ({
    id: `o${i + 1}`,
    name: o.name,
    summary: o.changes ?? "",
    pay: [o.costs ?? ""],
    recommended: o.recommended,
  }));
  const recommended = options.filter((o) => o.recommended);
  const chosen = recommended.length === 1 ? recommended[0] : undefined;
  if (chosen === undefined) return undefined;
  return {
    schema: "parked-decision/v1",
    class: item.class,
    call: {
      id: "a",
      question: r.Question,
      options: options.map(({ recommended: _recommended, ...o }) => o),
      recommended: chosen.id,
      why: r.Recommended,
    },
    steps: recordSteps(r["Steps for a person"]),
    alreadyDone: r["Already done"],
  };
}

/** Each person's last word, with deterministic ordering across readers. */
export function latestAnswers(
  answers: readonly PendingAnswer[],
): PendingAnswer[] {
  const latest = new Map<string, PendingAnswer>();
  for (const answer of [...answers].sort(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) ||
      a.url.localeCompare(b.url) ||
      (a.bodyHash ?? "").localeCompare(b.bodyHash ?? ""),
  ))
    latest.set(answer.author.toLowerCase(), answer);
  return [...latest.values()].sort((a, b) =>
    a.author.toLowerCase().localeCompare(b.author.toLowerCase()),
  );
}

/** All free answers are handed on. Structured answers require agreement. */
export function disputedAnswers(answers: readonly PendingAnswer[]): boolean {
  if (answers.every((a) => a.choice === undefined)) return false;
  const first = answers[0]?.choice;
  return (
    first === undefined ||
    answers.some(
      (a) =>
        a.choice === undefined ||
        a.choice.option !== first.option ||
        a.choice.note !== first.note,
    )
  );
}
