#!/usr/bin/env bun
/**
 * The store contract's conformance suite: run it against any store command
 * pointed at a fresh, empty store.
 *
 * Usage: bun store-contract.ts --command "<command>" [--timeout <seconds>]
 *        [--bulk <events>]
 *
 * It checks the store, appends findings and decisions, re-appends the same
 * events, runs concurrent appends whose events overlap, appends a different
 * event under a stored id both one after the other and concurrently, then
 * lists: the round trip byte
 * for byte, each id once, a conflict settled to the copy whose text sorts
 * first, and `since` never losing an event. It checks that `diagnose`
 * reports each conflict with every copy's text, the exit code for an unknown
 * operation, and that an invalid event is refused with the store unchanged.
 * Last, it appends `--bulk` events (250 by default) under a change each and
 * as many again under one change, with every kind of finding, and checks that
 * `list` returns every event the store holds, and `list` with a `since` the
 * bulk falls in every bulk event, once and byte for byte. The two halves page
 * differently: a store that reads only its first page of changes, or of one
 * change's events, is found when that page is smaller than `--bulk`, and a cap
 * on the whole listing when it is below what the listing must hold (with the
 * `since`, both halves; without it, the events stored before them too). So
 * `--bulk` is set above the store's own page and cap sizes.
 *
 * Output: one line per check, `ok` or `FAIL` with the reason. Exit codes: 0
 * every check passed; 1 a check failed; 2 usage.
 */
import { MAX_BUFFER_BYTES, tsArgv } from "../../../shared/proc.ts";
import { fail, runMain } from "../../../shared/cli.ts";
import { last, parseArgs } from "./lib/args.ts";
import {
  type DecisionEvent,
  eventText,
  type FindingEvent,
  jsonlLines,
  KINDS,
  parseObject,
  type ReflectionEvent,
} from "./lib/events.ts";
import { EXIT, runStore } from "./lib/store-client.ts";
import { isMapping } from "../../../shared/config-layers.ts";
import { splitWords } from "./lib/settings.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

let sequence = 0;

/**
 * The JSON object a store printed, or an empty one with the reason under
 * `_error`: a store that prints something else fails the check that reads
 * it rather than stopping the suite.
 */
function objectOf(text: string): Record<string, unknown> {
  try {
    return parseObject(text, "the store's output");
  } catch (error) {
    return { _error: error instanceof Error ? error.message : String(error) };
  }
}

/** A valid finding with a fixed id, for the suite's own writes. */
export function sampleFinding(
  id: string,
  title: string,
  at = "2026-10-12T15:04:05Z",
): FindingEvent {
  sequence++;
  return {
    v: 1,
    type: "finding",
    id,
    at,
    session: {
      jig_version: null,
      skills: ["store-contract"],
      harness: null,
      model: null,
      mode: null,
      stated: [],
    },
    change: {
      repository: "example.invalid/store-contract",
      branch: `contract-${sequence}`,
      pull_request: null,
      issue: null,
    },
    kind: "error",
    severity: "low",
    class: "store-contract-sample",
    target: { scope: "tool", tool: "jig", name: "reflect" },
    title,
    description: "An event the conformance suite writes.",
    suggested_fix: "None: a sample.",
  };
}

/** A valid decision about `finding`, for the suite's own writes. */
export function sampleDecision(
  id: string,
  finding: string,
  reason: string,
  at = "2026-10-12T15:04:05Z",
): DecisionEvent {
  return {
    v: 1,
    type: "decision",
    id,
    at,
    session: {
      jig_version: null,
      skills: ["store-contract"],
      harness: null,
      model: null,
      mode: null,
      stated: [],
    },
    finding,
    decision: "dismissed",
    reason,
  };
}

/**
 * The default bulk, appended once per way a store may page: more than the
 * common page and cap size of 100, not more than every store's.
 */
export const BULK_EVENTS = 250;

const ID = (n: number): string =>
  `20261012T150405Z-${n.toString(16).padStart(16, "0")}`;

/**
 * How a listing differs from the exact text expected under each id: how many
 * of the `required` ids it lacks (all of them when not given), and how many of
 * its lines repeat an id or are not that text.
 */
function compareListing(
  lines: readonly string[],
  expected: ReadonlyMap<string, string>,
  required: ReadonlySet<string> = new Set(expected.keys()),
): { missing: number; unexpected: number } {
  const found = new Set<string>();
  let unexpected = 0;
  for (const line of lines) {
    const id = String(objectOf(line).id);
    if (expected.get(id) === line && !found.has(id)) found.add(id);
    else unexpected++;
  }
  return {
    missing: [...required].filter((id) => !found.has(id)).length,
    unexpected,
  };
}

function jsonl(events: readonly ReflectionEvent[]): string {
  return `${events.map(eventText).join("\n")}\n`;
}

/**
 * Run every check against a store command; `env`, when given, is the
 * environment the command runs in, and `bulk` the events the exhaustiveness
 * check appends per way a store may page.
 */
export async function runConformance(
  command: readonly string[],
  timeoutSec = 60,
  env?: Record<string, string | undefined>,
  bulk = BULK_EVENTS,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const record = (name: string, ok: boolean, detail?: string): void => {
    results.push(
      detail === undefined || ok ? { name, ok } : { name, ok, detail },
    );
  };
  const call = (op: Parameters<typeof runStore>[1], input = "") =>
    runStore(command, op, input, timeoutSec, env);

  const check = await call("check");
  const checkOk = check.code === 0 && objectOf(check.stdout).ok === true;
  record(
    "check reports a reachable, writable store",
    checkOk,
    `exit ${check.code}: ${check.stdout}${check.stderr}`,
  );
  if (!checkOk) return results;

  const empty = await call("list");
  record(
    "a fresh store lists nothing",
    empty.code === 0 && jsonlLines(empty.stdout).length === 0,
    `exit ${empty.code}, ${jsonlLines(empty.stdout).length} events: point the command at a fresh store`,
  );

  const a = sampleFinding(ID(1), "first");
  const b = sampleFinding(ID(2), "second", "2026-10-13T09:00:00Z");
  const c = sampleFinding(ID(3), "third", "2026-10-14T09:00:00Z");
  const d = sampleFinding(ID(4), "fourth", "2026-10-15T09:00:00Z");
  // Decisions travel the same paths as findings: review-reflections writes
  // batches of decisions alone.
  const da = sampleDecision(ID(6), a.id, "a sample decision");
  const dc = sampleDecision(
    ID(7),
    c.id,
    "another sample decision",
    "2026-10-14T10:00:00Z",
  );
  const first = await call("append", jsonl([a, b, da]));
  record(
    "append reports every event stored",
    receipted(first, [a, b, da]),
    `exit ${first.code}: ${first.stdout}${first.stderr}`,
  );

  const again = await call("append", jsonl([a, b, da]));
  record(
    "re-appending stored events succeeds and reports them stored",
    receipted(again, [a, b, da]),
    `exit ${again.code}: ${again.stdout}${again.stderr}`,
  );

  const concurrentInputs: ReflectionEvent[][] = [
    [a, c, dc],
    [b, c, d, dc],
  ];
  const concurrent = await Promise.all(
    concurrentInputs.map((events) => call("append", jsonl(events))),
  );
  record(
    "concurrent appends with overlapping events both succeed and report them stored",
    concurrent.every((r, i) => receipted(r, concurrentInputs[i] ?? [])),
    concurrent.map((r) => `exit ${r.code}: ${r.stdout}${r.stderr}`).join("; "),
  );

  // A different event under a stored id, one after the other.
  const aOther = { ...a, title: "first, rewritten under the same id" };
  const sequential = await call("append", jsonl([aOther]));
  // Two different events under one new id, at the same time.
  const e1 = sampleFinding(ID(5), "fifth, one writer", "2026-10-16T09:00:00Z");
  const e2 = { ...e1, title: "fifth, the other writer" };
  const racing = await Promise.all([
    call("append", jsonl([e1])),
    call("append", jsonl([e2])),
  ]);
  record(
    "append does not refuse a different event under a stored id",
    receipted(sequential, [aOther]) && racing.every((r) => receipted(r, [e1])),
    [sequential, ...racing]
      .map((r) => `exit ${r.code}: ${r.stderr}`)
      .join("; "),
  );

  const listed = await call("list");
  const lines = jsonlLines(listed.stdout);
  const byId = new Map<string, string[]>();
  for (const line of lines) {
    const id = String(objectOf(line).id);
    byId.set(id, [...(byId.get(id) ?? []), line]);
  }
  record(
    "list succeeds",
    listed.code === 0,
    `exit ${listed.code}: ${listed.stderr}`,
  );
  record(
    "list returns each id once",
    [...byId.values()].every((texts) => texts.length === 1) && byId.size === 7,
    `ids: ${[...byId.entries()].map(([id, texts]) => `${id}×${texts.length}`).join(", ")}`,
  );
  const roundTrip = [b, c, d, da, dc].every(
    (event) => byId.get(event.id)?.[0] === eventText(event),
  );
  record("list returns each event byte for byte as appended", roundTrip);
  const firstOf = (x: string, y: string): string => (x < y ? x : y);
  record(
    "a conflict, written one after the other, returns the copy whose text sorts first",
    byId.get(a.id)?.[0] === firstOf(eventText(a), eventText(aOther)),
  );
  record(
    "a conflict, written concurrently, returns the copy whose text sorts first",
    byId.get(e1.id)?.[0] === firstOf(eventText(e1), eventText(e2)),
  );

  const since = await call("list", JSON.stringify({ since: c.at }));
  const sinceIds = new Set(
    jsonlLines(since.stdout).map((line) => objectOf(line).id),
  );
  record(
    "list with since returns every event at or after it",
    since.code === 0 && [c, d, e1, dc].every((event) => sinceIds.has(event.id)),
    `exit ${since.code}: ${[...sinceIds].join(", ")}`,
  );

  const diagnosed = await call("diagnose");
  const notices = jsonlLines(diagnosed.stdout).map(objectOf);
  const reports = (id: string, texts: string[]): boolean =>
    notices.some(
      (notice) =>
        notice.kind === "id-conflict" &&
        notice.id === id &&
        texts.every(
          (text) =>
            Array.isArray(notice.copies) &&
            notice.copies.some(
              (copy: unknown) => isMapping(copy) && copy.text === text,
            ),
        ),
    );
  record(
    "diagnose reports each conflict with every copy's text",
    diagnosed.code === 0 &&
      reports(a.id, [eventText(a), eventText(aOther)]) &&
      reports(e1.id, [eventText(e1), eventText(e2)]),
    `exit ${diagnosed.code}: ${diagnosed.stdout}`,
  );
  record(
    "diagnose reports nothing about an id stored once",
    !notices.some((notice) =>
      [b, c, d, da, dc].some((event) => notice.id === event.id),
    ),
  );

  const unknown = await call("frobnicate" as Parameters<typeof runStore>[1]);
  record(
    "an unknown operation exits 2",
    unknown.code === EXIT.usage,
    `exit ${unknown.code}`,
  );

  // Compared with a listing taken just before, so the check sees exactly
  // what the refused append changed.
  const before = await call("list");
  const invalid = await call("append", '{"v":1,"type":"finding"}\n');
  const after = await call("list");
  const unchanged =
    before.code === 0 &&
    after.code === 0 &&
    [...jsonlLines(before.stdout)].sort().join("\n") ===
      [...jsonlLines(after.stdout)].sort().join("\n");
  record(
    "an invalid event is refused and the store is unchanged",
    invalid.code !== 0 && unchanged,
    `exit ${invalid.code}; list exits ${before.code} before and ${after.code} after, ${jsonlLines(before.stdout).length} and ${jsonlLines(after.stdout).length} events`,
  );

  // Every event the store holds before the bulk, as `list` must return it:
  // each conflict settled as checked above.
  await checkBulkListing(
    {
      call,
      appendLarge: (input) =>
        runStore(command, "append", input, timeoutSec * 5, env),
      record,
    },
    [
      firstOf(eventText(a), eventText(aOther)),
      firstOf(eventText(e1), eventText(e2)),
      ...[b, c, d, da, dc].map(eventText),
    ],
    a.change,
    bulk,
  );
  return results;
}

type Call = (
  op: Parameters<typeof runStore>[1],
  input?: string,
) => ReturnType<typeof runStore>;

/** Whether an append succeeded and its receipt names every event sent. */
function receipted(
  result: { code: number; stdout: string },
  sent: ReadonlyArray<{ id: string }>,
): boolean {
  if (result.code !== 0) return false;
  const list = objectOf(result.stdout).stored;
  const ids = new Set(
    (Array.isArray(list) ? list : []).map((entry: unknown) =>
      isMapping(entry) ? entry.id : undefined,
    ),
  );
  return sent.every((event) => ids.has(event.id));
}

/**
 * The exhaustiveness checks: append `bulk` events per way a store may page to
 * a store holding the `stored` event texts, and require them all back.
 */
async function checkBulkListing(
  store: {
    call: Call;
    appendLarge: (input: string) => ReturnType<typeof runStore>;
    record: (name: string, ok: boolean, detail?: string) => void;
  },
  stored: readonly string[],
  change: FindingEvent["change"],
  bulk: number,
): Promise<void> {
  const { call, appendLarge, record } = store;
  // A listing cut at a page or a cap would still pass the checks before these
  // on a store that small, and passes these when the cut is past the bulk. The
  // classifier reasons from the classes `list` returns, so a class missing
  // from a short listing is coined again under a new name.
  // A store may page over its records as well as over the events within one,
  // so the events come both ways: each under a change of its own, and all
  // under one change. They carry every kind of finding, so a store that
  // refuses one fails here. The append gets the deadline `list` gets: it is a
  // large write.
  const bulkFinding = (n: number, title: string): FindingEvent => ({
    ...sampleFinding(ID(n), title, "2026-10-17T09:00:00Z"),
    kind: KINDS[n % KINDS.length] as FindingEvent["kind"],
  });
  const bulkEvents = [
    ...Array.from({ length: bulk }, (_, i) =>
      bulkFinding(1000 + i, `bulk, change ${i}`),
    ),
    ...Array.from({ length: bulk }, (_, i) => ({
      ...bulkFinding(1000 + bulk + i, `bulk, one change, ${i}`),
      change,
    })),
  ];
  const bulkAppend = await appendLarge(jsonl(bulkEvents));
  // Every event the store now holds, as `list` must return it.
  const expected = new Map<string, string>(
    [...stored, ...bulkEvents.map(eventText)].map((text) => [
      String(objectOf(text).id),
      text,
    ]),
  );
  const bulkListed = await call("list");
  const bulkLines = jsonlLines(bulkListed.stdout);
  const { missing, unexpected } = compareListing(bulkLines, expected);
  record(
    `list returns all ${expected.size} stored events once each, byte for byte, more than one page holds`,
    receipted(bulkAppend, bulkEvents) &&
      bulkListed.code === 0 &&
      missing === 0 &&
      unexpected === 0,
    `append exit ${bulkAppend.code}: ${bulkAppend.stderr}; list exit ${bulkListed.code}: ${bulkListed.stderr}; ${missing} of ${expected.size} events missing, ${unexpected} of ${bulkLines.length} lines repeated or not as appended`,
  );
  // The same with a `since` every bulk event is at or after, which a store
  // may answer with a different query. Older events may come back too, since
  // a store may ignore `since`.
  const bulkSince = await call(
    "list",
    JSON.stringify({ since: bulkEvents[0]?.at }),
  );
  const sinceLines = jsonlLines(bulkSince.stdout);
  const sinceDiff = compareListing(
    sinceLines,
    expected,
    new Set(bulkEvents.map((event) => event.id)),
  );
  record(
    `list with since returns all ${bulkEvents.length} events at or after it once each, byte for byte`,
    bulkSince.code === 0 &&
      sinceDiff.missing === 0 &&
      sinceDiff.unexpected === 0,
    `list exit ${bulkSince.code}: ${bulkSince.stderr}; ${sinceDiff.missing} of ${bulkEvents.length} events missing, ${sinceDiff.unexpected} of ${sinceLines.length} lines repeated or not as appended`,
  );
}

/**
 * The bytes a bulk event's line stays within: its fields are fixed but for
 * the digits of its id, title and branch, which the widest bulk keeps far
 * below this.
 */
export const BULK_LINE_BYTES = 1024;

/**
 * The largest `--bulk`: a listing of twice this many events, plus the events
 * stored before them, fits with room to spare in the output a store call may
 * capture before it is stopped.
 */
export const MAX_BULK = Math.floor(MAX_BUFFER_BYTES / BULK_LINE_BYTES / 4);

/** The largest `--timeout`, in seconds: a deadline every timer can hold. */
export const MAX_TIMEOUT_SEC = 3600;

const USAGE = `usage: store-contract.ts --command "<command>" [--timeout <seconds, at most 3600>] [--bulk <events, at most ${MAX_BULK}>]`;

/** The store command, with `bun <script>` run under this same runtime. */
function commandOf(line: string | undefined): string[] {
  const words = line === undefined ? [] : splitWords(line);
  if (words.length === 0) fail(2, USAGE);
  // `bun` names this same runtime, so the suite runs where no `bun` is on PATH.
  return words[0] === "bun" && words[1]?.endsWith(".ts")
    ? tsArgv(words[1], words.slice(2))
    : words;
}

/**
 * A whole number option from 1 to `max`, or `fallback` when it is not given;
 * checked before any store operation, so a bad value leaves the store empty.
 */
function countOf(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > max) fail(2, USAGE);
  return Number(value);
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ["command", "timeout", "bulk"]);
  if (typeof args === "string" || args.positional.length > 0) fail(2, USAGE);
  const results = await runConformance(
    commandOf(last(args, "command")),
    countOf(last(args, "timeout"), 60, MAX_TIMEOUT_SEC),
    undefined,
    countOf(last(args, "bulk"), BULK_EVENTS, MAX_BULK),
  );
  for (const result of results)
    console.log(
      `${result.ok ? "ok  " : "FAIL"} ${result.name}${result.ok ? "" : `: ${result.detail ?? ""}`}`,
    );
  return results.every((result) => result.ok) ? 0 : 1;
}

if (import.meta.main)
  runMain("store-contract.ts", () => main(process.argv.slice(2)));
