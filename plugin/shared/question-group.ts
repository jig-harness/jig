/**
 * Question groups: the needs of one host's line whose framed decisions are
 * identical apart from the target each is about, which every reader that
 * follows Needs you's rules shows as one card settled by one answer
 * ([design/need-classes.md § Identical questions fold](../../design/need-classes.md#identical-questions-fold)).
 *
 * Two needs are in one group only when all of these hold: the same act
 * and the same number of decisions, and each decision, in
 * order, has the same kind, class and station, and the same question,
 * recommendation, options (each name, what it changes, what it costs, its
 * details and whether it is recommended), steps and interplay once the
 * need's own target identifier is replaced. Only that identifier is
 * replaced: another item or pull request named in the text stays, so a
 * question naming it groups only with questions naming the same one. The
 * repository is not part of the key.
 *
 * A need never groups when a person has more to read on it than the
 * question: it has no decision, a decision has no options, a decision has
 * answers that keep it waiting (stale, disputed or not read), or the tick
 * refused the answer it acted on. Such a need is always a card of its own.
 *
 * Pure data and functions with no `node:` import: the dashboard's page
 * bundles it, and `jig ask --waiting` names each need's group with the same
 * identity (`questionGroupId`).
 */
import type {
  LineDecision,
  LineNeed,
} from "../dispatch/lib/dashboard-contract.ts";
import { actOfLineNeed } from "./acts.ts";

/** What stands in for the need's own target in the text the key compares. */
const TARGET = "\u0000target\u0000";

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The forms of a need's own target identifier: its target, its item, and its pull request as `PR #n`, longest first. */
function ownIdentifiers(
  need: Pick<LineNeed, "target" | "item" | "pr">,
): string[] {
  const ids = [
    need.target,
    ...(need.item === null ? [] : [need.item]),
    ...(need.pr === null ? [] : [`PR #${need.pr}`]),
  ].filter((id) => id.trim() !== "");
  return [...new Set(ids)].sort((a, b) => b.length - a.length);
}

/**
 * `text` with every whole occurrence of the need's own target identifier
 * replaced by `by`: an identifier inside a longer one (`#12` in `#123`, or in
 * `owner/name#12`) is another target's and stays.
 */
export function replaceOwnTarget(
  text: string,
  need: Pick<LineNeed, "target" | "item" | "pr">,
  by: string,
): string {
  let out = text;
  for (const id of ownIdentifiers(need))
    out = out.replace(
      new RegExp(`(?<![\\w#/.-])${escaped(id)}(?![\\w])`, "g"),
      () => by,
    );
  return out;
}

/** Whether a person has more to read on the decision than its question. */
function standsAlone(d: LineDecision): boolean {
  return (
    (d.options ?? []).length === 0 ||
    (d.answers ?? []).length > 0 ||
    d.answerState !== undefined ||
    d.unread !== undefined ||
    d.acted?.outcome === "refused"
  );
}

/** One decision as the key compares it. */
function decisionKey(d: LineDecision, own: (text: string) => string) {
  const or = (text: string | null) => (text === null ? null : own(text));
  return {
    kind: d.kind,
    class: d.decisionClass,
    typed: d.decision !== undefined,
    station:
      d.answer === undefined
        ? null
        : [d.answer.station, d.answer.on, d.answer.framedBy],
    question: or(d.question),
    recommendation: or(d.recommendation),
    options: (d.options ?? []).map((o) => ({
      name: own(o.name),
      changes: or(o.changes),
      costs: or(o.costs),
      recommended: o.recommended,
      details: (o.details ?? []).map((x) => [x.label, own(x.text)]),
    })),
    steps: (d.steps ?? []).map(own),
    interplay: (d.decision?.interplay ?? []).map((x) => own(x.text)),
  };
}

/** What two needs of one group share, as text; `null` for a need that is always a card of its own. */
export function questionGroupKey(need: LineNeed): string | null {
  if (need.decisions.length === 0 || need.decisions.some(standsAlone))
    return null;
  const own = (text: string) => replaceOwnTarget(text, need, TARGET);
  return JSON.stringify({
    act: actOfLineNeed(need),
    decisions: need.decisions.map((d) => decisionKey(d, own)),
  });
}

/** A 53-bit string hash (cyrb53), as hex. */
function hash53(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0))
    .toString(16)
    .padStart(14, "0");
}

/**
 * The identity of the group a need is in, the same on every reader of one
 * line: `q-` and a digest of its key. `null` for a need that is always a
 * card of its own. A group of one is an ordinary card.
 */
export function questionGroupId(need: LineNeed): string | null {
  const key = questionGroupKey(need);
  return key === null ? null : `q-${hash53(key, 1)}${hash53(key, 2)}`;
}

/**
 * The needs in groups, in the order of each group's first need, and each
 * group's needs in their order in `needs`. A need that never groups is a
 * group of its own.
 */
export function questionGroups<T extends LineNeed>(needs: readonly T[]): T[][] {
  const groups: T[][] = [];
  const byKey = new Map<string, T[]>();
  for (const need of needs) {
    const key = questionGroupKey(need);
    const known = key === null ? undefined : byKey.get(key);
    if (known !== undefined) {
      known.push(need);
      continue;
    }
    const group = [need];
    groups.push(group);
    if (key !== null) byKey.set(key, group);
  }
  return groups;
}
