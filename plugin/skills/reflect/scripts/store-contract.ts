#!/usr/bin/env bun
/**
 * The store contract's conformance suite: run it against any store command
 * pointed at a fresh, empty store.
 *
 * Usage: bun store-contract.ts --command "<command>" [--timeout <seconds>]
 *
 * It checks the store, appends findings and decisions, re-appends the same
 * events, runs concurrent appends whose events overlap, appends a different
 * event under a stored id both one after the other and concurrently, then
 * lists: the round trip byte
 * for byte, each id once, a conflict settled to the copy whose text sorts
 * first, and `since` never losing an event. It checks that `diagnose`
 * reports each conflict with every copy's text, the exit code for an unknown
 * operation, and that an invalid event is refused with the store unchanged.
 *
 * Output: one line per check, `ok` or `FAIL` with the reason. Exit codes: 0
 * every check passed; 1 a check failed; 2 usage.
 */
import { tsArgv } from "../../../shared/proc.ts";
import { fail, runMain } from "../../../shared/cli.ts";
import { last, parseArgs } from "./lib/args.ts";
import {
  type DecisionEvent,
  eventText,
  type FindingEvent,
  jsonlLines,
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

const ID = (n: number): string =>
  `20261012T150405Z-${n.toString(16).padStart(16, "0")}`;

function jsonl(events: readonly ReflectionEvent[]): string {
  return `${events.map(eventText).join("\n")}\n`;
}

/**
 * Run every check against a store command; `env`, when given, is the
 * environment the command runs in.
 */
export async function runConformance(
  command: readonly string[],
  timeoutSec = 60,
  env?: Record<string, string | undefined>,
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
  /** Whether an append succeeded and its receipt names every event sent. */
  const receipted = (
    result: { code: number; stdout: string },
    sent: ReadonlyArray<{ id: string }>,
  ): boolean => {
    if (result.code !== 0) return false;
    const list = objectOf(result.stdout).stored;
    const ids = (Array.isArray(list) ? list : []).map((entry: unknown) =>
      isMapping(entry) ? entry.id : undefined,
    );
    return sent.every((event) => ids.includes(event.id));
  };

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
  return results;
}

const USAGE =
  'usage: store-contract.ts --command "<command>" [--timeout <seconds>]';

/** The store command, with `bun <script>` run under this same runtime. */
function commandOf(line: string | undefined): string[] {
  const words = line === undefined ? [] : splitWords(line);
  if (words.length === 0) fail(2, USAGE);
  // `bun` names this same runtime, so the suite runs where no `bun` is on PATH.
  return words[0] === "bun" && words[1]?.endsWith(".ts")
    ? tsArgv(words[1], words.slice(2))
    : words;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ["command", "timeout"]);
  if (typeof args === "string" || args.positional.length > 0) fail(2, USAGE);
  const timeout = last(args, "timeout") ?? "60";
  if (!/^[1-9][0-9]*$/.test(timeout)) fail(2, USAGE);
  const results = await runConformance(
    commandOf(last(args, "command")),
    Number(timeout),
  );
  for (const result of results)
    console.log(
      `${result.ok ? "ok  " : "FAIL"} ${result.name}${result.ok ? "" : `: ${result.detail ?? ""}`}`,
    );
  return results.every((result) => result.ok) ? 0 : 1;
}

if (import.meta.main)
  runMain("store-contract.ts", () => main(process.argv.slice(2)));
