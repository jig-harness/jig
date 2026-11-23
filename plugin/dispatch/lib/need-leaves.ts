/**
 * What left the line, and how: the dashboard's "Settled recently" and
 * `jig ask --settled`. The line holds only what is open, so a need that leaves
 * it leaves no trace there. Each tick compares the merged line it writes with
 * the line before, whatever its notify stage did, and records every need that
 * is gone as one row of `need_leaves` with when it left, by whom and how:
 *
 * | What the tick holds of the need | By | How |
 * | --- | --- | --- |
 * | a person's answer the tick carried out (`station_answers`), or the receipt of a park's answer | the person's login | the option chosen and what the step did |
 * | a record the steward submitted and the tick applied to its target | the steward | its record |
 * | another action of the tick on its target | the tick | the rule's stage and reason |
 * | its pull request is no longer open, or nothing else is known | no one | what changed |
 *
 * A need that returns is a new need, so it leaves in a new row. The rows come
 * from the tick's own reads and records: no forge or tracker call is made. The
 * line's `settled` list is those rows of the last day, with the answers a
 * station took and could not carry out (held or refused), whose cards stay
 * open. One answer that settled several needs is one entry listing them all.
 */
import type { Database } from "bun:sqlite";
import { actOfLineNeed } from "../../shared/acts.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import type { LineNeed, LineSettled } from "./dashboard-contract.ts";
import type { ParkLeft } from "./park-events.ts";

/** How far back the line's settled list reaches. */
export const SETTLED_WINDOW_MS = 24 * 3_600_000;
/** The most entries the line carries, newest first. */
const SETTLED_LIMIT = 100;
/** Held and refused answers are read in pages of this many rows, until the list is full or the window is read to its start. */
const UNSETTLED_PAGE = 200;
/** How long a leave row is kept. */
const LEAVES_KEPT_MS = 7 * 24 * 3_600_000;

/** A person's answer a station took, as `station_answers` holds it. */
export interface AnswerSeen {
  /** The decision it answers. */
  key: string;
  /** The framing it answers: a key can be framed again with another digest. */
  digest: string;
  author: string;
  option: string;
  answer: string;
  claimedAt: string;
  outcome: "done" | "refused" | "held" | null;
  detail: string | null;
}

/** Whether the answer is to this occurrence of the decision: its key, and its digest when the framing carries one. */
function answersDecision(
  a: { key: string; digest: string },
  d: LineNeed["decisions"][number],
): boolean {
  return d.key === a.key && (d.digest === undefined || d.digest === a.digest);
}

/** What the tick did to one target this tick, besides notifying. */
export interface ActionSeen {
  repo: string;
  target: string;
  stage: string;
  reason: string;
  /** The steward record the action carries out. */
  steward?: number;
}

/** What the tick holds that says how a need left. */
export interface LeaveEvidence {
  /** The answers taken for a target since a time, newest first. */
  answers: (repo: string, target: string, since: string) => AnswerSeen[];
  /** The parks that left the ledgers this tick. */
  parks: readonly ParkLeft[];
  actions: readonly ActionSeen[];
  /** The open pull requests the forge listed by repository; absent or `null` when its listing did not read. */
  open: ReadonlyMap<string, readonly number[] | null>;
}

const keyOf = (n: Pick<LineNeed, "repo" | "target" | "cause">): string =>
  `${n.repo}\u0000${n.target}\u0000${n.cause}`;

/** The items a need is about: its target, and for a group of releases every item it lists. */
const itemsOf = (n: LineNeed): string[] => [n.target, ...(n.covers ?? [])];

/** The needs of `before` that `after` no longer holds. A group of releases whose target moved on but still lists an item it did before is the same need. */
export function leftNeeds(
  before: readonly LineNeed[],
  after: readonly LineNeed[],
): LineNeed[] {
  const kept = new Set(after.map(keyOf));
  return before.filter(
    (n) =>
      !kept.has(keyOf(n)) &&
      !after.some(
        (a) =>
          a.repo === n.repo &&
          a.cause === n.cause &&
          (n.covers ?? []).length > 0 &&
          itemsOf(a).some((item) => itemsOf(n).includes(item)),
      ),
  );
}

/** The question or act a need carried, in the words it carries. */
function questionOf(need: LineNeed): string | null {
  const asked = need.question ?? need.decisions[0]?.question ?? null;
  return asked ?? (need.reason === "" ? null : need.reason);
}

const where = (target: string): string =>
  target.startsWith("PR #") ? "a comment on the pull request" : "a comment";

/** Who settled a need and how: the part of an entry that differs by cause. */
type Why = Pick<
  LineSettled,
  "by" | "who" | "via" | "option" | "recommended" | "how" | "answer"
> & { at?: string; occurrence?: string };

const NO_ONE = {
  via: null,
  option: null,
  recommended: null,
  answer: null,
} as const;

/** The comment link of an answer's identity (`<link> <time>`). */
const linkOf = (answer: string): string => answer.split(" ")[0] ?? answer;

/** A person's answer a station carried out. */
function personAnswered(need: LineNeed, a: AnswerSeen): Why {
  return {
    by: "person",
    who: a.author,
    via: where(need.target),
    option: a.option,
    recommended: null,
    how: `chose ${a.option}${a.detail === null ? "" : `: ${a.detail}`}`,
    answer: linkOf(a.answer),
    occurrence: a.answer,
  };
}

/** A park that left its ledger: answered by people, or handed on or withdrawn by the line's own rules. */
function parkLeft(need: LineNeed, park: ParkLeft): Why {
  if (park.outcome === "answered")
    return {
      at: park.at,
      by: "person",
      who: park.people.join(", ") || null,
      via: where(need.target),
      option: park.option,
      recommended: park.recommended,
      how: park.words.join("; ") || "answered",
      answer: park.url,
      occurrence: `park ${park.digest ?? ""} ${park.parkedAt ?? ""} ${park.url ?? ""}`,
    };
  return {
    ...NO_ONE,
    by: "tick",
    who: "park rule",
    how:
      park.outcome === "provisional"
        ? "handed on unanswered, to be decided provisionally"
        : park.outcome === "resolved-thread"
          ? "the thread was already resolved on the forge, without a human answer"
          : "the park left its ledger: it was withdrawn or framed again",
  };
}

/** What the tick did to the target besides notifying: a steward's record, else a rule. */
function tickActed(acted: readonly ActionSeen[]): Why | null {
  const steward = acted.find((a) => a.steward !== undefined);
  if (steward !== undefined)
    return {
      ...NO_ONE,
      by: "steward",
      who: `steward record #${steward.steward}`,
      how: steward.reason,
    };
  const rule = acted[0];
  return rule === undefined
    ? null
    : { ...NO_ONE, by: "tick", who: `${rule.stage} rule`, how: rule.reason };
}

/** No answer or action accounts for it: its facts changed. */
function factsChanged(
  need: LineNeed,
  after: readonly LineNeed[],
  open: readonly number[] | null | undefined,
): Why {
  const changed = after.find(
    (n) => n.repo === need.repo && n.target === need.target,
  );
  const closed =
    need.pr !== null && open !== undefined && open !== null
      ? !open.includes(need.pr)
      : false;
  const what =
    changed !== undefined
      ? `it is now ${changed.cause}`
      : closed
        ? "its pull request is no longer open (merged or closed)"
        : `the line no longer finds the cause (${need.cause})`;
  return {
    ...NO_ONE,
    by: "facts",
    who: null,
    how: `its facts changed: ${what}`,
  };
}

/** The entry that says `need` left the line at `at`. */
export function leaveOf(
  need: LineNeed,
  after: readonly LineNeed[],
  ev: LeaveEvidence,
  at: string,
): LineSettled {
  // Only an answer or a park of a decision this need carried settled it: another need on the target may have been answered, and a need with no decision has no answer to credit.
  const answered = ev
    .answers(need.repo, need.target, need.since)
    .find(
      (a) =>
        a.outcome === "done" &&
        need.decisions.some((d) => answersDecision(a, d)),
    );
  const park =
    need.cause === "parked"
      ? ev.parks.find(
          (p) =>
            p.repo === need.repo &&
            p.target === need.target &&
            need.decisions.some(
              (d) =>
                d.key === p.key &&
                (d.digest === undefined ||
                  p.digest === null ||
                  d.digest === p.digest) &&
                (d.parkedAt === undefined ||
                  p.parkedAt === null ||
                  d.parkedAt === p.parkedAt),
            ),
        )
      : undefined;
  const open = ev.open.get(need.repo);
  const gone = need.pr !== null && open != null && !open.includes(need.pr);
  const acted = ev.actions.filter(
    (a) => a.repo === need.repo && a.target === need.target,
  );
  // A pull request no longer open settles its needs whatever else the tick planned for it (a follow-up, say).
  const why =
    (answered === undefined ? null : personAnswered(need, answered)) ??
    (park === undefined ? null : parkLeft(need, park)) ??
    tickActed(acted.filter((a) => a.steward !== undefined)) ??
    (gone ? null : tickActed(acted)) ??
    factsChanged(need, after, open);
  return {
    repo: need.repo,
    targets: [need.target],
    cause: need.cause,
    act: actOfLineNeed(need),
    title: need.title,
    url: need.url,
    question: questionOf(need),
    outcome: "left",
    ...why,
    at: why.at ?? at,
  };
}

/** One row per need that left, written in the tick's transaction. */
export function insertLeaves(
  db: Database,
  leaves: readonly LineSettled[],
): void {
  const add = db.query(
    "INSERT INTO need_leaves (repo, target, cause, at_ms, value) VALUES (?, ?, ?, ?, ?)",
  );
  for (const leave of leaves)
    add.run(
      leave.repo,
      leave.targets[0] ?? "",
      leave.cause ?? "",
      parseMs(leave.at),
      JSON.stringify(leave),
    );
}

/** Drop the rows older than the days they are kept. */
export function pruneLeaves(db: Database, nowMs: number): void {
  db.query("DELETE FROM need_leaves WHERE at_ms < ?").run(
    nowMs - LEAVES_KEPT_MS,
  );
}

/** The answers a station took for a target since a time, newest first. */
export function answersFrom(
  db: Database,
): (repo: string, target: string, since: string) => AnswerSeen[] {
  return (repo, target, since) =>
    (
      db
        .query(
          `SELECT key, digest, author, option, answer, claimed_at AS claimedAt, outcome, detail
           FROM station_answers
           WHERE repo = ? AND target = ? AND claimed_at >= ?
           ORDER BY claimed_at DESC, rowid DESC`,
        )
        .all(repo, target, since) as Array<
        Omit<AnswerSeen, "outcome"> & { outcome: string | null }
      >
    ).map((r) => ({
      ...r,
      outcome:
        r.outcome === "done" || r.outcome === "refused" || r.outcome === "held"
          ? r.outcome
          : null,
    }));
}

function parsed(value: string): LineSettled | null {
  try {
    const found: unknown = JSON.parse(value);
    return isMapping(found) &&
      Array.isArray(found.targets) &&
      typeof found.at === "string"
      ? (found as unknown as LineSettled)
      : null;
  } catch (err) {
    swallow(err, "a need's leave row does not read as JSON");
    return null;
  }
}

/** One answer that settled several needs is one entry listing every target. */
function grouped(entries: readonly LineSettled[]): LineSettled[] {
  const out: LineSettled[] = [];
  const byAnswer = new Map<string, LineSettled>();
  for (const e of entries) {
    // One answer: the same occurrence (comment and the time it was counted from, so an edit is another) and the same choice. Its targets leave in different ticks, so the tick's time is not part of it; the entry keeps the newest.
    const key =
      e.occurrence == null
        ? null
        : `${e.repo} ${e.occurrence} ${e.outcome} ${e.option ?? ""}`;
    const same = key === null ? undefined : byAnswer.get(key);
    if (same === undefined) {
      const copy = { ...e, targets: [...e.targets] };
      out.push(copy);
      if (key !== null) byAnswer.set(key, copy);
    } else
      same.targets.push(...e.targets.filter((t) => !same.targets.includes(t)));
  }
  return out;
}

/** An answer a station took and could not carry out, as an entry; its need, when it is still on the line, gives the rest. */
function unsettledEntry(
  a: AnswerSeen & { repo: string; target: string },
  need: LineNeed,
): LineSettled {
  const outcome = a.outcome === "refused" ? "refused" : "held";
  return {
    repo: a.repo,
    targets: [a.target],
    cause: need.cause,
    act: actOfLineNeed(need),
    title: need.title,
    url: need.url,
    question: questionOf(need),
    at: a.claimedAt,
    outcome,
    by: "person",
    who: a.author,
    via: where(a.target),
    option: a.option,
    recommended: null,
    how: `chose ${a.option}, ${outcome}${a.detail === null ? "" : `: ${a.detail}`}; its card stays open`,
    answer: linkOf(a.answer),
    occurrence: a.answer,
  };
}

/** A newest-first read taken a page at a time: `frontier` is the time of the last row read, and nothing older has been read. */
function pagedRows(
  read: (offset: number) => {
    rows: LineSettled[];
    full: boolean;
    lastMs: number | null;
  },
): { done: boolean; frontier: number; next: () => LineSettled[] } {
  let offset = 0;
  const source = {
    done: false,
    frontier: Number.POSITIVE_INFINITY,
    next: (): LineSettled[] => {
      const page = read(offset);
      offset += UNSETTLED_PAGE;
      if (page.lastMs !== null) source.frontier = page.lastMs;
      if (!page.full) source.done = true;
      return page.rows;
    },
  };
  return source;
}

/**
 * The line's settled list: the needs that left in the window and the answers
 * taken and not carried out (their needs are open on `needs`), newest first.
 */
export function readSettled(
  db: Database,
  nowMs: number,
  needs: readonly LineNeed[],
): LineSettled[] {
  const since = nowMs - SETTLED_WINDOW_MS;
  const leftPages = pagedRows((offset) => {
    const page = db
      .query(
        "SELECT value, at_ms AS atMs FROM need_leaves WHERE at_ms >= ? ORDER BY at_ms DESC, id DESC LIMIT ? OFFSET ?",
      )
      .all(since, UNSETTLED_PAGE, offset) as Array<{
      value: string;
      atMs: number;
    }>;
    return {
      rows: page.flatMap((r) => {
        const entry = parsed(r.value);
        return entry === null ? [] : [entry];
      }),
      full: page.length === UNSETTLED_PAGE,
      lastMs: page.at(-1)?.atMs ?? null,
    };
  });
  const unsettledPages = pagedRows((offset) => {
    const page = db
      .query(
        `SELECT repo, target, key, digest, author, option, answer, claimed_at AS claimedAt, outcome, detail
         FROM station_answers a
         WHERE claimed_at >= ? AND outcome IN ('held', 'refused')
           AND NOT EXISTS (
             SELECT 1 FROM station_answers b
             WHERE b.repo = a.repo AND b.target = a.target AND b.key = a.key
               AND b.digest = a.digest
               AND b.outcome = 'done' AND b.claimed_at > a.claimed_at)
         ORDER BY claimed_at DESC, rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(isoFromMs(since), UNSETTLED_PAGE, offset) as Array<
      AnswerSeen & { repo: string; target: string }
    >;
    return {
      rows: page.flatMap((a) => {
        // Its card stays open: an answer to a decision no open need carries is not listed as unsettled.
        const need = needs.find(
          (n) =>
            n.repo === a.repo &&
            n.target === a.target &&
            n.decisions.some((d) => answersDecision(a, d)),
        );
        return need === undefined ? [] : [unsettledEntry(a, need)];
      }),
      full: page.length === UNSETTLED_PAGE,
      lastMs:
        page.length === 0
          ? null
          : parseMs(page[page.length - 1]?.claimedAt ?? ""),
    };
  });
  // Both reads page newest first; read on until the grouped list is full and
  // every source has gone past the oldest entry kept, so grouping sees the
  // whole window it needs before the cap cuts.
  const rows: LineSettled[] = [];
  let kept: LineSettled[] = [];
  for (;;) {
    const sources = [leftPages, unsettledPages].filter((s) => !s.done);
    if (sources.length === 0) break;
    const edge =
      kept.length >= SETTLED_LIMIT
        ? parseMs(kept[SETTLED_LIMIT - 1]?.at ?? "")
        : null;
    const next = sources.filter((s) => edge === null || s.frontier >= edge);
    if (next.length === 0) break;
    for (const s of next) rows.push(...s.next());
    kept = grouped(rows.sort((a, b) => parseMs(b.at) - parseMs(a.at)));
  }
  // A kept answer's other targets may have left before the point the paging
  // stopped at: read every row of those answers so each entry lists them all.
  const shown = kept.slice(0, SETTLED_LIMIT);
  const occurrences = [
    ...new Set(
      shown.flatMap((e) => (e.occurrence == null ? [] : [e.occurrence])),
    ),
  ];
  if (occurrences.length === 0) return shown;
  const marks = occurrences.map(() => "?").join(", ");
  const more = (
    db
      .query(
        `SELECT value FROM need_leaves WHERE at_ms >= ? AND json_extract(value, '$.occurrence') IN (${marks})`,
      )
      .all(since, ...occurrences) as Array<{ value: string }>
  ).flatMap((r) => {
    const entry = parsed(r.value);
    return entry === null ? [] : [entry];
  });
  const answered = db
    .query(
      `SELECT repo, target, key, digest, author, option, answer, claimed_at AS claimedAt, outcome, detail
       FROM station_answers a
       WHERE claimed_at >= ? AND outcome IN ('held', 'refused') AND answer IN (${marks})
         AND NOT EXISTS (
           SELECT 1 FROM station_answers b
           WHERE b.repo = a.repo AND b.target = a.target AND b.key = a.key
             AND b.digest = a.digest
             AND b.outcome = 'done' AND b.claimed_at > a.claimed_at)`,
    )
    .all(isoFromMs(since), ...occurrences) as Array<
    AnswerSeen & { repo: string; target: string }
  >;
  const extra = answered.flatMap((a) => {
    const need = needs.find(
      (n) =>
        n.repo === a.repo &&
        n.target === a.target &&
        n.decisions.some((d) => answersDecision(a, d)),
    );
    return need === undefined ? [] : [unsettledEntry(a, need)];
  });
  return grouped(
    [...rows, ...more, ...extra].sort((a, b) => parseMs(b.at) - parseMs(a.at)),
  ).slice(0, SETTLED_LIMIT);
}
