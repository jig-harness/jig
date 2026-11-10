/** The human verdict handed to a pass, with choices and notes kept whole. */
import { renderParkedDecision } from "../../../../../shared/decisions/park.ts";
import type { PendingVerdict, PendingAnswer } from "../state/pass-handoff.ts";

const ANSWER_BODY_MAX = 1500;
const REASON_MAX = 300;
const CHOICE_MAX = 300;
export const NOTICE_MAX = 15_000;
const CUT = "… (cut; read the rest at the url or in the file named above)";
const clip = (text: string, max: number, why: string) =>
  text.length > max ? `${text.slice(0, max)}… (cut; ${why})` : text;
const indent = (body: string) =>
  body
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

function answerHeading(a: PendingAnswer): string {
  const by = `  answered by ${a.author} at ${a.at} (${a.url}):`;
  if (a.choice === undefined) return by;
  return [
    by,
    `  @${a.author} chose **${clip(a.choice.option, CHOICE_MAX, "read the complete retained choice in the file named above")}**${a.choice.recommended ? " (the recommended option)" : ""}${a.choice.digest === undefined ? "" : ` from framing ${a.choice.digest}`}. Apply this option as the framed decision states it.`,
    ...(a.choice.note === undefined
      ? []
      : [`  Note from @${a.author}: ${a.choice.note}`]),
  ].join("\n");
}

/** The budget cuts only copied bodies and decisions, never chosen names or notes. */
export function humanVerdictNotice(
  verdicts: readonly PendingVerdict[],
  file: string,
): string {
  if (verdicts.length === 0) return "";
  const head = [
    "RE-ARMED WITH HUMAN ANSWERS: every parked item was answered by an owner, member or collaborator after it was parked, and is unparked.",
    "Treat each answer as a person's verdict on its item: act on it this round, reply with the outcome it leads to, and resolve or hold as usual.",
    "For a structured choice, apply the named option and name it and its author in the outcome. A note may narrow the option or set a condition, never widen it. If the note conflicts or cannot be applied, park again and quote the note.",
    `Every answer and framed decision in full: ${file}`,
  ];
  const entries = verdicts.map((v) => ({
    entry: `- [${v.kind}] ${v.key} — ${v.answers[0]?.url ?? "(no url)"} — parked: ${clip(v.reason, REASON_MAX, "see the thread")}`,
    answers: v.answers.map((a) => ({ line: answerHeading(a), body: a.body })),
    decision:
      v.decision === undefined ? undefined : renderParkedDecision(v.decision),
  }));
  const floor = indent(CUT).length + 1;
  const count = entries.reduce(
    (n, e) => n + e.answers.length + (e.decision === undefined ? 0 : 1),
    0,
  );
  const skeleton = [
    ...head,
    ...entries.flatMap((e) => [e.entry, ...e.answers.map((a) => a.line)]),
  ].join("\n").length;
  let room = NOTICE_MAX - skeleton - floor * count;
  const lines = [...head];
  for (const e of entries) {
    lines.push(e.entry);
    if (e.decision !== undefined) {
      const decision = fit(
        e.decision,
        floor + Math.max(0, room),
        Number.POSITIVE_INFINITY,
      );
      room -= decision.length + 1 - floor;
      lines.push(decision);
    }
    for (const a of e.answers) {
      const body = fit(a.body, floor + Math.max(0, room), ANSWER_BODY_MAX);
      room -= body.length + 1 - floor;
      lines.push(a.line, body);
    }
  }
  return lines.join("\n");
}

function fit(body: string, max: number, limit: number): string {
  if (body.length <= limit && indent(body).length + 1 <= max)
    return indent(body);
  let n = Math.min(limit, body.length);
  let out = indent(`${body.slice(0, n)}${CUT}`);
  while (n > 0 && out.length + 1 > max) {
    n = Math.max(0, n - (out.length + 1 - max));
    out = indent(`${body.slice(0, n)}${CUT}`);
  }
  return out;
}
