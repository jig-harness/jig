/**
 * What the reflection route's tests share: a command store that answers the
 * store contract from a folder, and can be told to fail, hang or lose an
 * answer, and the event rows of a drive stopped for a person.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type FindingEvent,
  parseEvent,
} from "../../skills/reflect/scripts/lib/events.ts";
import type { LogRow, OutcomeClass } from "../lib/log.ts";

/**
 * A command store that keeps each event it is given as a line of
 * `events.jsonl` and logs each operation to `calls.log`. While `fail` exists
 * it answers unavailable, while `hang` exists it never answers, and once
 * `lost` exists it keeps an append's events and then loses its answer.
 */
const FAKE_STORE = (dir: string) => `const fs = require("node:fs");
const D = ${JSON.stringify(dir)};
const op = process.argv[2];
fs.appendFileSync(D + "/calls.log", op + "\\n");
if (fs.existsSync(D + "/hang")) Bun.sleepSync(30000);
if (fs.existsSync(D + "/fail")) { process.stderr.write("the store is down\\n"); process.exit(3); }
const input = fs.readFileSync(0, "utf8");
const events = D + "/events.jsonl";
if (op === "append") {
  const lines = input.split("\\n").filter((l) => l.trim() !== "");
  fs.appendFileSync(events, lines.map((l) => l + "\\n").join(""));
  if (fs.existsSync(D + "/lost")) { fs.rmSync(D + "/lost"); process.stderr.write("the answer was lost\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({ stored: lines.map((l, i) => ({ id: JSON.parse(l).id, ref: "events.jsonl:" + (i + 1) })) }));
  process.exit(0);
}
if (op === "list") { process.stdout.write(fs.existsSync(events) ? fs.readFileSync(events, "utf8") : ""); process.exit(0); }
process.stdout.write(JSON.stringify({ ok: true }));
`;

export interface FakeStore {
  /** The store's folder. */
  dir: string;
  /** The store command, as `reflection.command` names it. */
  command: string[];
  /** The store's operations so far, in order. */
  calls(): string[];
  /** The lines the store was given, as they arrived. */
  lines(): string[];
  /** The lines the store was given, as events. */
  events(): FindingEvent[];
  flag(name: "fail" | "hang" | "lost", on?: boolean): void;
}

/** A fake store under `parent`. */
export function fakeStore(parent: string): FakeStore {
  const dir = join(parent, "store");
  mkdirSync(dir, { recursive: true });
  const script = join(parent, "fake-store.js");
  writeFileSync(script, FAKE_STORE(dir));
  const lines = (name: string) =>
    existsSync(join(dir, name))
      ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
      : [];
  return {
    dir,
    command: [process.execPath, script],
    calls: () => lines("calls.log"),
    lines: () => lines("events.jsonl"),
    events: () =>
      lines("events.jsonl").map((l) => parseEvent(l) as FindingEvent),
    flag: (name, on = true) => {
      if (on) writeFileSync(join(dir, name), "");
      else rmSync(join(dir, name), { force: true });
    },
  };
}

/** The event row of a drive stopped for a person, as the tick's notification writes it; `null` for a drift, which carries no class. */
export function stoppedRow(
  repo: string,
  atMs: number,
  n: number,
  cls: OutcomeClass | null = "gates failed",
  stage = "rearm",
): LogRow {
  return {
    kind: "event",
    key: `event stop ${stage} ${cls} ${atMs} ${n}`,
    at: new Date(atMs).toISOString(),
    repo,
    stage,
    target: `PR #${n}`,
    event: cls === null ? "drifting" : "needs-person",
    account: null,
    class: cls,
    reason:
      n % 2 === 0
        ? "stopped 14: only a person settles it (see the drive's handoff)"
        : "stopped 1: only a person settles it (see the drive's handoff)",
  };
}
