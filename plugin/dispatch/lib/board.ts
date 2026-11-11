/**
 * The board read: one repository's converged pull requests placed by the
 * Ready predicate (`skills/drive-pr/scripts/lib/merge-ready.ts`) in a lane
 * of Ready to merge, or wherever its reason says
 * (design/dispatch-board.md § Ready, exactly and § The board read).
 *
 * It runs in the tick's observe phase, through the observe pool, as a query
 * of its own (`merge-facts.ts`), apart from the repository's query
 * (`forge-batch.ts`): planning reads nothing it reads, so a board read that
 * fails, runs past its deadline or is skipped for the forge's budget marks
 * the repository's ready list "not read" with the reason and leaves the
 * listing, the ledgers and every launch as they were. Planning runs under the
 * act lock, so the read is not placed after it, where it would hold that
 * lock across forge calls.
 *
 * Every fact is bound to one head: the head the board read gives must be the
 * head the tick's listing gave, read once more where they differ, and a pull
 * request whose heads still differ is not placed. One whose mergeability is
 * still being computed is read once more after `UNKNOWN_WAIT_MS`, within the
 * deadline, so the tick after a merge does not leave the list unread.
 *
 * Update next holds one pull request per repository: the first behind its
 * base in Ready order; every other one behind its base is in Coming,
 * updated after it.
 */
import {
  type FactsRead,
  readMergeFacts,
} from "../../skills/drive-pr/scripts/lib/merge-facts.ts";
import {
  checkPattern,
  type ForgeFacts,
  type Lane,
  type Readiness,
  type ReadyCondition,
  readiness,
  type ReadyRules,
  readyOrder,
  type WaitsOn,
} from "../../skills/drive-pr/scripts/lib/merge-ready.ts";
import { defaultReviewerCheckFor } from "../../skills/drive-pr/scripts/lib/overlay.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { isRecord } from "../../shared/guards.ts";
import type { Contention } from "./contention.ts";
import { attempt, type Outcome } from "../../shared/outcome.ts";
import type { TickBudget } from "./tick-reads.ts";
import { readyNotice } from "./notices.ts";
import type { Action, DrivenPr } from "./types.ts";

/** How long one repository's board read may take. */
export const BOARD_DEADLINE_MS = 30_000;

/** How long to wait before reading a pull request whose mergeability is `UNKNOWN` once more. */
export const UNKNOWN_WAIT_MS = 15_000;

/** Below this share of its limit left, the forge's budget is kept for the drives and the board read is skipped. */
const BUDGET_FLOOR_SHARE = 0.2;

/** One converged pull request as the board places it. */
export interface BoardCard {
  number: number;
  url: string;
  title: string;
  /** The head the drive verified. */
  head: string;
  place: Readiness["place"];
  lane: Lane | null;
  says: string;
  waitsOn: WaitsOn;
  conditions: ReadyCondition[];
  failing: string[];
  requested: string[];
  command: string | null;
  withheld: string | null;
  /** The pull requests that wait behind it in a serialized area. */
  unblocks: number[];
  /** When its drive converged, as its ledger last wrote. */
  since: string;
}

/** One repository's board read. */
export interface BoardRead {
  /** Whether the read placed its converged pull requests; `false` with `reason` when it did not. */
  ok: boolean;
  reason: string | null;
  cards: BoardCard[];
  /** The pull requests the read could not place this tick, with why. */
  unread: Array<{ number: number; reason: string }>;
  /** The converged pull requests whose place this tick could not tell (not read, or where they were): a notification about one is not settled by its absence. */
  pending: number[];
  ms: number;
  /** What the forge charged for it, in its points, and what it left. */
  cost: number;
  remaining: number | null;
}

/** What a board read is given. */
export interface BoardInput {
  slug: string;
  /** The repository's configuration on its default branch. */
  values: Record<string, unknown>;
  drives: readonly DrivenPr[];
  /** Each open pull request's head as the tick's listing gave it. */
  heads: ReadonlyMap<number, string>;
  /** The pull requests a person's hold label holds. */
  held: ReadonlySet<number>;
  serialized: Pick<Contention, "held">;
  budget: TickBudget;
}

/** What the board read reads through, which a test replaces. */
export interface BoardIo {
  read: (
    slug: string,
    numbers: readonly number[],
    timeoutSec: number,
  ) => Promise<Outcome<FactsRead, "unreadable">>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

const realIo: BoardIo = {
  read: readMergeFacts,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/** A nested string setting of the repository's configuration, `null` when absent or empty. */
function setting(
  values: Record<string, unknown>,
  ...path: string[]
): string | null {
  let v: unknown = values;
  for (const key of path) v = isRecord(v) ? v[key] : undefined;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** The repository's Ready rules, from its configuration on the default branch. */
export function rulesOf(values: Record<string, unknown>): ReadyRules {
  const reviewerApp = setting(values, "review", "reviewer_app");
  return {
    reviewerApp,
    reviewerCheck: checkPattern(
      setting(values, "review", "reviewer_check_pattern") ??
        defaultReviewerCheckFor(reviewerApp),
    ),
    ciHoldLabel: setting(values, "ci", "hold_label"),
  };
}

/** The drives the board places: stopped converged, at the head they verified. */
export function convergedDrives(drives: readonly DrivenPr[]): DrivenPr[] {
  return drives.filter(
    (d) => d.class === "done" && d.evidence.exit === DRIVE_EXIT.CONVERGED,
  );
}

/** Why the forge's budget keeps the board read from running; `null` while it runs. */
function budgetFloor(budget: TickBudget): string | null {
  if (!("remaining" in budget)) return null;
  return budget.remaining < budget.limit * BUDGET_FLOOR_SHARE
    ? `the forge budget is kept for the drives (${budget.remaining} of ${budget.limit} left)`
    : null;
}

/** An empty read, with why nothing was placed. */
function notRead(reason: string, pending: number[], ms = 0): BoardRead {
  return {
    ok: false,
    reason,
    cards: [],
    unread: [],
    pending,
    ms,
    cost: 0,
    remaining: null,
  };
}

/** Read the board's facts, then once more those whose head moved or whose mergeability is not computed yet, within the deadline. */
async function readFacts(
  input: BoardInput,
  numbers: number[],
  io: BoardIo,
  startedMs: number,
  retryUnread: Map<number, string>,
): Promise<Outcome<FactsRead, "unreadable">> {
  const left = () => BOARD_DEADLINE_MS - (io.now() - startedMs);
  const seconds = () => Math.max(1, Math.floor(left() / 1000));
  const read = await io.read(input.slug, numbers, seconds());
  if (!read.ok) return read;
  const first = read.value;
  const again = (f: ForgeFacts | undefined, n: number) =>
    f !== undefined &&
    (f.head !== input.heads.get(n) || f.mergeable === "UNKNOWN");
  const retry = numbers.filter((n) => again(first.pulls.get(n), n));
  if (retry.length === 0) return read;
  const unknown = retry.some(
    (n) => first.pulls.get(n)?.mergeable === "UNKNOWN",
  );
  if (unknown) {
    if (left() <= UNKNOWN_WAIT_MS + 1000) return read;
    await io.wait(UNKNOWN_WAIT_MS);
  }
  // A second read that fails leaves the first: its moved heads unplaced, its unknown mergeability where it was.
  if (left() <= 0) return read;
  const reread = await io.read(input.slug, retry, left() / 1000);
  if (!reread.ok) {
    for (const n of retry)
      retryUnread.set(n, `the board retry failed: ${reread.failure.reason}`);
    return read;
  }
  const second = reread.value;
  for (const [n, f] of second.pulls) first.pulls.set(n, f);
  first.cost += second.cost;
  first.remaining = second.remaining ?? first.remaining;
  return read;
}

/** One repository's board read (see the module comment). */
export async function readBoard(
  input: BoardInput,
  io: BoardIo = realIo,
): Promise<BoardRead> {
  const converged = convergedDrives(input.drives);
  if (converged.length === 0)
    return {
      ok: true,
      reason: null,
      cards: [],
      unread: [],
      pending: [],
      ms: 0,
      cost: 0,
      remaining: null,
    };
  const numbers = converged.map((d) => d.number);
  const floor = budgetFloor(input.budget);
  if (floor !== null) return notRead(floor, numbers);
  const startedMs = io.now();
  const retryUnread = new Map<number, string>();
  const facts = await readFacts(input, numbers, io, startedMs, retryUnread);
  if (!facts.ok)
    return notRead(
      `the board read failed: ${facts.failure.reason}`,
      numbers,
      io.now() - startedMs,
    );
  const read = facts.value;
  const ms = io.now() - startedMs;
  if (ms > BOARD_DEADLINE_MS)
    return notRead(
      `the board read ran past its ${BOARD_DEADLINE_MS / 1000} s deadline`,
      numbers,
      ms,
    );
  const checkedRules = attempt(
    "unreadable",
    "the board review rules are invalid",
    () => rulesOf(input.values),
  );
  if (!checkedRules.ok)
    return notRead(checkedRules.failure.reason, numbers, ms);
  const rules = checkedRules.value;
  const cards: BoardCard[] = [];
  const unread: BoardRead["unread"] = [];
  for (const drive of converged) {
    const retryFailure = retryUnread.get(drive.number);
    if (retryFailure !== undefined) {
      unread.push({ number: drive.number, reason: retryFailure });
      continue;
    }
    const facts = read.pulls.get(drive.number);
    const listed = input.heads.get(drive.number);
    if (facts === undefined) {
      unread.push({
        number: drive.number,
        reason: "the board read did not give it",
      });
      continue;
    }
    if (facts.head !== listed) {
      unread.push({
        number: drive.number,
        reason: `its head moved between the tick's reads (${String(listed).slice(0, 7)}, then ${facts.head.slice(0, 7)})`,
      });
      continue;
    }
    const verifiedSha = String(drive.evidence.verifiedSha ?? "");
    const answer = readiness(
      {
        ...facts,
        slug: input.slug,
        converged: true,
        verifiedSha,
        held: input.held.has(drive.number),
      },
      rules,
    );
    cards.push({
      number: drive.number,
      url: drive.url,
      title: drive.title,
      head: verifiedSha,
      place: answer.place,
      lane: answer.lane,
      says: answer.says,
      waitsOn: answer.waitsOn,
      conditions: answer.conditions,
      failing: answer.failing,
      requested: answer.requested,
      command: answer.command,
      withheld: answer.withheld,
      unblocks: [...input.serialized.held]
        .filter(([, hold]) => hold.leader === drive.number)
        .map(([n]) => n)
        .sort((a, b) => a - b),
      since: String(drive.evidence.heartbeat ?? ""),
    });
  }
  return {
    ok: true,
    reason: null,
    cards: oneUpdateNext(cards),
    unread,
    pending: [
      ...unread.map((u) => u.number),
      ...cards.filter((c) => c.place === "stay").map((c) => c.number),
    ],
    ms,
    cost: read.cost,
    remaining: read.remaining,
  };
}

/** Ready to merge in its order, with one pull request in update next and every other one behind its base in Coming. */
export function oneUpdateNext(cards: BoardCard[]): BoardCard[] {
  const ready = readyOrder(
    cards.flatMap((c) => (c.lane === null ? [] : [{ ...c, lane: c.lane }])),
  );
  const first = ready.find((c) => c.lane === "update-next");
  const placed = ready.map(
    (c): BoardCard =>
      c.lane !== "update-next" || c === first
        ? c
        : {
            ...c,
            place: "coming",
            lane: null,
            says: `behind its base, updated after #${first?.number} in update next`,
            waitsOn: { kind: "waiting", for: `#${first?.number}` },
            command: null,
          },
  );
  return [...placed, ...cards.filter((c) => c.lane === null)];
}

/** The board read in the observe phase: a failure is a value on the report, and touches nothing the tick plans or launches (ADR-0012). */
export async function observeBoard(
  input: Omit<BoardInput, "budget" | "heads"> & {
    open: ReadonlyArray<{ number: number; headRefOid?: string }>;
    budget: () => Promise<TickBudget>;
  },
  io: BoardIo = realIo,
): Promise<BoardRead> {
  const heads = new Map(
    input.open.flatMap((p) =>
      p.headRefOid === undefined ? [] : [[p.number, p.headRefOid] as const],
    ),
  );
  return await readBoard({ ...input, heads, budget: await input.budget() }, io);
}

/** The notifications of the pull requests in merge now and approve first: each sent once per pull request and verified head. */
export function readyActions(
  slug: string,
  board: BoardRead | undefined,
): Action[] {
  if (board === undefined) return [];
  return board.cards.flatMap((card): Action[] => {
    const lane = card.lane;
    if (lane !== "merge-now" && lane !== "approve-first") return [];
    return [
      {
        stage: "notify",
        target: `PR #${card.number}`,
        record: "forge",
        reason: `ready to merge, ${lane}: ${card.says}`,
        evidence: { lane, verifiedSha: card.head },
        cause: "ready",
        notice: readyNotice(slug, { ...card, lane }),
      },
    ];
  });
}
