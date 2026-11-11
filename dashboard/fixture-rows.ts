/**
 * The fixtures' outcome log: the rows a night leaves, trouble that recurs, and a
 * long history, on the day the scenarios are fixed to.
 */
import type {
  EndedRow,
  EventRow,
  LogRow,
  OutcomeClass,
} from "../plugin/dispatch/lib/log.ts";

const BASE = Date.UTC(2026, 10, 3);

/** The server's clock in every scenario. */
export const NOW_MS = BASE + (16 * 60 + 47.5) * 60_000;
export const WEB = "example-org/web";
export const API = "example-org/api";
export const MOB = "example-org/mobile";
export const DOC = "example-org/docs";
export const INF = "example-org/infra";

/** A time on the day, in minutes since its midnight. */
export function T(hour: number, minute: number): number {
  return hour * 60 + minute;
}

/** A time `ago` days before the day. */
function D(ago: number, hour: number, minute: number): number {
  return -ago * 1440 + hour * 60 + minute;
}

export function iso(minutes: number): string {
  return new Date(BASE + minutes * 60_000).toISOString();
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function prUrl(repo: string, pr: number): string {
  return `https://forge.example/${repo}/pull/${pr}`;
}

let recordSerial = 0;

/** Starts a scenario's records from the same serial, so every run holds the same rows. */
export function resetRecords(): void {
  recordSerial = 0;
}

export function ended(
  at: number,
  repo: string,
  stage: EndedRow["stage"],
  target: string,
  account: string,
  cls: OutcomeClass,
  reason: string,
  minutes: number,
  rounds: number | null,
): EndedRow {
  recordSerial += 1;
  const stampPart = `${pad(Math.abs(at) % 24)}${pad(Math.abs(at) % 60)}31Z`;
  const record = `20261102T${stampPart}-ab${recordSerial.toString(16)}cd34`;
  return {
    kind: "ended",
    key: `ended ${record}`,
    at: iso(at),
    repo,
    stage,
    target,
    record,
    account,
    model: null,
    durationMs: minutes * 60_000,
    rounds,
    class: cls,
    reason,
  };
}

export function observed(
  at: number,
  repo: string,
  stage: string,
  target: string,
  event: string,
  cls: OutcomeClass | null,
  reason: string,
  account: string | null,
  minutes?: number,
): EventRow {
  recordSerial += 1;
  return {
    kind: "event",
    key: `event ${event} ${target} ${recordSerial}`,
    at: iso(at),
    repo,
    stage,
    target,
    event,
    account,
    class: cls,
    reason,
    ...(minutes === undefined ? {} : { durationMs: minutes * 60_000 }),
  };
}

export function nightly(): LogRow[] {
  return [
    ended(
      T(7, 22),
      API,
      "rearm",
      "PR #1205",
      "work-a",
      "converged",
      "exit 0 (converged)",
      74,
      4,
    ),
    ended(
      T(4, 48),
      WEB,
      "rearm",
      "PR #463",
      "codex-a",
      "merged",
      "exit 5 (merged)",
      52,
      3,
    ),
    ended(
      T(3, 2),
      INF,
      "rearm",
      "PR #92",
      "work-b",
      "quota wall",
      "exit 16 (quota-parked)",
      38,
      2,
    ),
    ended(
      T(1, 15),
      WEB,
      "rearm",
      "PR #471",
      "work-a",
      "converged",
      "exit 0 (converged)",
      130,
      7,
    ),
    ended(
      T(0, 40),
      API,
      "rearm",
      "PR #1201",
      "codex-b",
      "converged",
      "exit 0 (converged)",
      61,
      5,
    ),
  ];
}

const REDRIVE =
  "exit 1 (failed); re-drive of a stale converged pull request: conflicting with its base";

function repeatedTrouble(): LogRow[] {
  const rows: LogRow[] = [];
  for (const i of [1, 2, 3, 5, 6])
    rows.push(
      ended(
        D(i, 2, 10 + i),
        WEB,
        "rearm",
        `PR #${456 + i}`,
        "work-a",
        "gates failed",
        REDRIVE,
        41 + i,
        4,
      ),
    );
  for (const i of [1, 2, 4, 6])
    rows.push(
      ended(
        D(i, 4, 20 + i),
        WEB,
        "rearm",
        `PR #${470 + i}`,
        "work-b",
        "stalled",
        "exit 14 (stalled)",
        95 + i,
        6,
      ),
    );
  rows.push(
    ended(
      D(1, 21, 2),
      API,
      "rearm",
      "PR #1202",
      "codex-a",
      "converged",
      "exit 0 (converged)",
      66,
      3,
    ),
    observed(
      D(1, 22, 40),
      INF,
      "rearm",
      "PR #91",
      "hold end",
      null,
      "held: serialized behind #90 in migrations",
      null,
      40,
    ),
  );
  return rows;
}

/** A long history: thousands of rows over thirty days, from a seed so every run holds the same. */
export function generated(): LogRow[] {
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  const names = ["work-a", "work-b", "work-c", "codex-a", "codex-b"];
  const account = () => names[rnd(names.length)] ?? "work-a";
  const other: Array<[string, OutcomeClass, string]> = [
    [API, "converged", "exit 0 (converged)"],
    [INF, "merged", "exit 5 (merged)"],
    [API, "stalled", "exit 14 (stalled)"],
    [INF, "quota wall", "exit 16 (quota-parked)"],
    [WEB, "gates failed", "exit 7 (failed); pass deadline reached"],
    [API, "gates failed", REDRIVE],
  ];
  const rows: LogRow[] = [];
  for (let i = 0; i < 6210; i++)
    rows.push(
      ended(
        T(16, 40) - Math.floor(i * 6.9),
        WEB,
        "rearm",
        `PR #${456 + rnd(34)}`,
        account(),
        "gates failed",
        REDRIVE,
        20 + rnd(100),
        rnd(10),
      ),
    );
  for (let i = 0; i < 1480; i++) {
    const [repo, cls, reason] = other[rnd(other.length)] ?? [
      API,
      "converged",
      "",
    ];
    rows.push(
      ended(
        T(16, 30) - i * 29,
        repo,
        "rearm",
        `PR #${1203 + rnd(18)}`,
        account(),
        cls,
        reason,
        3 + rnd(120),
        rnd(10),
      ),
    );
  }
  return rows;
}

export function loudRows(): LogRow[] {
  return [
    ...nightly(),
    ended(
      T(11, 40),
      WEB,
      "rearm",
      "PR #462",
      "work-a",
      "gates failed",
      REDRIVE,
      44,
      5,
    ),
    ended(
      T(9, 12),
      WEB,
      "rearm",
      "PR #474",
      "work-b",
      "stalled",
      "exit 14 (stalled)",
      110,
      6,
    ),
    observed(
      T(7, 10),
      WEB,
      "rearm",
      "PR #456",
      "parked",
      "parked for a person",
      "drive ledger parked: stopped 8 (parked), waiting on thread PRRT_x1, thread PRRT_x2: a person answers",
      "work-a",
    ),
    ...repeatedTrouble(),
  ];
}
