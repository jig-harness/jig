/**
 * quota.test.ts — the subscription-quota adapters and the sleep/stop decision
 * built on them (`scripts/lib/quota/`).
 *
 * WHAT THESE TESTS ARE FOR. The module's whole job is to keep an unattended
 * drive from doing the one thing it must never do: sleep for days on a wall it
 * misread. Every case below therefore pins a DECISION, not a parse — the
 * question is always "sleep or stop", because that is the only output with a
 * consequence.
 *
 * FIXTURES, NOT THE MACHINE'S REAL STATE. The adapters read a real dev tool's
 * transcript tree, and pointing the suite at the developer's own would make it
 * pass or fail on what they happened to run this week. Each adapter takes a
 * directory override for exactly this reason, and the wordings and record
 * shapes below are transcribed verbatim from measured samples on the machine
 * an earlier change was filed from — 371 Claude `rate_limit` records and 1342 Codex
 * rollouts. Where the corpus had no sample (a Claude WEEKLY wall; any Codex
 * wall at all, since none was ever reached), the test says so and pins the
 * fail-closed behaviour instead of inventing the vendor's wording.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter } from "../scripts/lib/quota/claude.ts";
import { codexAdapter } from "../scripts/lib/quota/codex.ts";
import {
  detectQuotaBlock,
  maxSleepMs,
  planFor,
  prepareQuotaSpawn,
  snapshotQuotaSessions,
} from "../scripts/lib/quota/index.ts";
import {
  forEachDirEntry,
  isConfirmedAbsence,
  maxCandidateScanMs,
  type QuotaBlock,
  type QuotaWindow,
  readBoundedTail,
  scanBudgetExceeded,
} from "../scripts/lib/quota/types.ts";
import { parseResetClause } from "../scripts/lib/quota/wallclock.ts";

const CWD = "/Users/dev/workspaces/proj/alpha";
const OTHER_CWD = "/Users/dev/workspaces/proj/beta";

let root: string;
const ENV_KEYS = [
  "DRIVE_PR_CLAUDE_PROJECTS_DIR",
  "DRIVE_PR_CODEX_SESSIONS_DIR",
  "DRIVE_PR_QUOTA_MAX_SLEEP_SEC",
  "DRIVE_PR_QUOTA_MAX_SCAN_MS",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "DRIVE_PR_QUOTA_NO_SPAWN_PREP",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = mkdtempSync(join(tmpdir(), "drive-pr-quota-test-"));
  // The adapters are pointed at the fixture tree for EVERY test, including
  // the ones that expect no block: an adapter left pointing at the real home
  // directory would answer from the developer's own transcripts, and a test
  // that passes because a machine happens to be quiet has verified nothing.
  process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR = join(root, "claude");
  process.env.DRIVE_PR_CODEX_SESSIONS_DIR = join(root, "codex");
  for (const k of ENV_KEYS.slice(2)) delete process.env[k];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** One Claude transcript line, in the measured record shape. */
function claudeWall(opts: {
  cwd: string;
  timestamp: string;
  text: string;
  isApiErrorMessage?: unknown;
  apiErrorStatus?: unknown;
  sessionId?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    cwd: opts.cwd,
    timestamp: opts.timestamp,
    error: "rate_limit",
    isApiErrorMessage: opts.isApiErrorMessage ?? true,
    apiErrorStatus: opts.apiErrorStatus ?? 429,
    // Omitted entirely when the test does not supply one — `JSON.stringify`
    // drops an `undefined` value — so the older fixtures keep the
    // exact shape they always had.
    sessionId: opts.sessionId,
    message: { content: [{ type: "text", text: opts.text }] },
  });
}

function writeClaude(name: string, lines: string[]): void {
  const dir = join(root, "claude", "-Users-dev-workspaces-proj-alpha");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
}

/** A Codex rollout: a `session_meta` head line plus arbitrary event lines. */
function writeCodexRaw(
  name: string,
  cwd: string,
  events: Array<{ timestamp: string; payload: unknown; type?: string }>,
): void {
  const dir = join(root, "codex", "2026", "08", "20");
  mkdirSync(dir, { recursive: true });
  const head = JSON.stringify({
    timestamp: "2026-08-20T10:00:00.000Z",
    type: "session_meta",
    payload: { cwd, id: "x", cli_version: "0.144.6" },
  });
  const body = events.map((e) =>
    JSON.stringify({
      timestamp: e.timestamp,
      type: e.type ?? "event_msg",
      payload: e.payload,
    }),
  );
  writeFileSync(join(dir, name), `${[head, ...body].join("\n")}\n`);
}

/** A Codex rollout: a `session_meta` head line plus `token_count` events. */
function writeCodex(
  name: string,
  cwd: string,
  events: Array<{ timestamp: string; rate_limits: unknown }>,
): void {
  writeCodexRaw(
    name,
    cwd,
    events.map((e) => ({
      timestamp: e.timestamp,
      payload: { type: "token_count", info: {}, rate_limits: e.rate_limits },
    })),
  );
}

function window(
  usedPercent: number,
  windowMinutes: number,
  resetsAtIso: string,
): Record<string, number> {
  return {
    used_percent: usedPercent,
    window_minutes: windowMinutes,
    resets_at: Math.floor(Date.parse(resetsAtIso) / 1000),
  };
}

const SINCE = new Date("2026-08-20T12:00:00.000Z");
// Safely after every fixture timestamp in this file, so it never trips the
// upper-bound (future-timestamp) rejection unless a test constructs its own.
const NOW = new Date("2026-08-20T14:00:00.000Z");

describe("wall-clock reset parsing", () => {
  // Every spelling here was transcribed from a real transcript; the point of
  // the table is that the vendor is not consistent about any of them.
  const now = new Date("2026-08-20T21:31:00Z"); // 23:31 Europe/Amsterdam
  it.each([
    ["resets 11:40pm (Europe/Amsterdam)", "2026-08-20T21:40:00.000Z"],
    ["resets 3:20am (Europe/Amsterdam)", "2026-08-21T01:20:00.000Z"],
    ["resets 11:40pm Europe/Amsterdam", "2026-08-20T21:40:00.000Z"],
    ["resets 10pm (Europe/Amsterdam)", "2026-08-21T20:00:00.000Z"],
  ])("resolves %p", (text, expected) => {
    expect(parseResetClause(text, now)?.at.toISOString()).toBe(expected);
  });

  it("resolves to a whole second, never the reference instant’s milliseconds", () => {
    const odd = new Date("2026-08-20T21:31:00.884Z");
    const at = parseResetClause("resets 11:40pm (Europe/Amsterdam)", odd)?.at;
    expect(at?.getUTCMilliseconds()).toBe(0);
  });

  it("does NOT advance a full day for a reset seconds into the SAME minute", () => {
    // `now` carries 30 seconds past the announced reset minute, but the reset
    // is announced at second-0 precision — comparing at full instant precision
    // would reject today's candidate as "already past" by those 30 seconds and
    // fabricate a ~24-hour delay instead, contradicting this module's own
    // documented "at or after" contract.
    const now = new Date("2026-08-20T16:40:30Z"); // 18:40:30 Europe/Amsterdam
    expect(
      parseResetClause(
        "resets 6:40pm (Europe/Amsterdam)",
        now,
      )?.at.toISOString(),
    ).toBe("2026-08-20T16:40:00.000Z");
  });

  it("crosses a DST boundary using the offset AT THE ANSWER, not at now", () => {
    // 2026-10-25 03:00 CEST -> 02:00 CET in Europe/Amsterdam. At 23:30 local
    // on the 24th (UTC+2) a 03:20 reset lands after the switch (UTC+1), so a
    // single-pass offset would be an hour wrong.
    const before = new Date("2026-10-24T21:30:00Z");
    expect(
      parseResetClause(
        "resets 3:20am (Europe/Amsterdam)",
        before,
      )?.at.toISOString(),
    ).toBe("2026-10-25T02:20:00.000Z");
  });

  it("resolves the REPEATED fall-back occurrence rather than jumping a full day", () => {
    // 2026-10-25: Europe/Amsterdam's 02:00-03:00 local window occurs TWICE —
    // once as CEST (00:00-01:00 UTC) and again as CET (01:00-02:00 UTC). At
    // 00:45 UTC the first 02:30 occurrence (00:30 UTC) has already passed,
    // but the second one (01:30 UTC) is only 45 minutes away — jumping to
    // tomorrow instead would blow well past planFor's 6-hour sleep cap.
    const duringFallBack = new Date("2026-10-25T00:45:00Z");
    expect(
      parseResetClause(
        "resets 2:30am (Europe/Amsterdam)",
        duringFallBack,
      )?.at.toISOString(),
    ).toBe("2026-10-25T01:30:00.000Z");
  });

  it("resolves the FIRST fall-back occurrence when `now` is seconds into its SAME minute", () => {
    // The minute-floor fix once applied only to the OUTER "at or after"
    // decision, not to this INNER check deciding whether to seek the later
    // ambiguous occurrence — so a `now` a few seconds past the first
    // occurrence's own minute (00:30:30Z here, 30 seconds after the first 00:30
    // occurrence) was treated as "already passed" at full instant precision,
    // and this substituted the SECOND occurrence (01:30Z) instead of correctly
    // returning the still-valid first one — sleeping roughly an unnecessary
    // extra hour.
    const secondsIntoFirstOccurrence = new Date("2026-10-25T00:30:30Z");
    expect(
      parseResetClause(
        "resets 2:30am (Europe/Amsterdam)",
        secondsIntoFirstOccurrence,
      )?.at.toISOString(),
    ).toBe("2026-10-25T00:30:00.000Z");
  });

  it.each([
    ["resets 11:40pm (UTC)", "2026-08-20T23:40:00.000Z"],
    ["resets 11:40pm (GMT)", "2026-08-20T23:40:00.000Z"],
  ])("resolves a single-component zone %p", (text, expected) => {
    // UTC and GMT are valid Intl.DateTimeFormat zones with no `/` at all —
    // requiring one meant a genuinely resolvable zone parsed as "no reset
    // clause found" and fell through to QUOTA_PARKED instead of sleeping.
    expect(parseResetClause(text, now)?.at.toISOString()).toBe(expected);
  });

  it.each([
    // EST5EDT is a real, DST-observing IANA backward-compat zone name — a
    // digit-blind class truncates it to `EST`, a DIFFERENT valid zone fixed
    // at UTC-5 with no DST, resolving an August reset an hour off from the
    // UTC-4 (EDT) it should have used.
    ["resets 11:40pm (EST5EDT)", "2026-08-21T03:40:00.000Z"],
    // Etc/GMT+5 (note the inverted POSIX sign: this is UTC-5, no DST) — a
    // digit-blind class truncates it to the invalid `Etc/GMT+`, which used
    // to fall through to QUOTA_PARKED instead of resolving and sleeping.
    ["resets 11:40pm (Etc/GMT+5)", "2026-08-21T04:40:00.000Z"],
  ])("resolves a zone identifier containing digits %p", (text, expected) => {
    expect(parseResetClause(text, now)?.at.toISOString()).toBe(expected);
  });

  it.each([
    "no reset clause at all",
    "resets 99:99am (Europe/Amsterdam)",
    "resets 3:20am (Not/AZone)",
    "resets 13pm (Europe/Amsterdam)",
    // An OPEN paren with no CLOSE, ending the string right after the zone —
    // independently-optional `\(?...\)?` groups accepted this too, and once
    // this pattern is embedded in an ANCHORED, fail-closed matcher (the Claude
    // adapter's session-limit notice), accepting it means classifying a
    // malformed notice as a trusted, sleepable window. The mirror case — a bare
    // zone with a stray trailing `)` and no matching `(` — is NOT a case for
    // this function: `parseResetClause` searches for an EMBEDDED clause and is
    // never anchored to the end of the string, so trailing text after a
    // validly-recognised bare zone is by design not this function's problem;
    // the claude-adapter test below covers it where it actually matters, in the
    // anchored notice matcher.
    "resets 6:40pm (Europe/Amsterdam",
  ])("returns null rather than guessing for %p", (text) => {
    expect(parseResetClause(text, now)).toBeNull();
  });

  it("refuses a wall clock that does not exist on a spring-forward day", () => {
    // 2026-03-29: Europe/Amsterdam jumps 02:00 CET -> 03:00 CEST, so no local
    // instant that day displays 02:30. Without a round-trip check the two-pass
    // offset correction lands on some OTHER instant and reports it as if the
    // requested wall clock were real.
    const springForwardEve = new Date("2026-03-28T20:00:00Z"); // 21:00 CET
    expect(
      parseResetClause("resets 2:30am (Europe/Amsterdam)", springForwardEve),
    ).toBeNull();
  });
});

describe("readBoundedTail", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bounded-tail-"));
    path = join(dir, "f.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the whole file when it is under the bound", () => {
    const content = "line-1\nline-2\nline-3\n";
    writeFileSync(path, content);
    expect(readBoundedTail(path, 1024)).toBe(content);
  });

  it("returns only whole lines within the tail bound, dropping earlier content and any partial leading line", () => {
    // Twenty fixed-width (8-byte) lines, 160 bytes total. A 20-byte bound
    // lands the tail read mid-way through line-17's own bytes ("-17\n...")
    // — the partial fragment must be dropped along with everything before
    // it, keeping only the whole lines that follow: line-18, line-19.
    const lines = Array.from(
      { length: 20 },
      (_, i) => `line-${String(i).padStart(2, "0")}`,
    );
    writeFileSync(path, `${lines.join("\n")}\n`);
    const result = readBoundedTail(path, 20);
    expect(result).toBe("line-18\nline-19\n");
  });

  it("reads only the tail of a file much larger than the bound, and still finds a record living in it", () => {
    // A multi-megabyte prefix the bound must skip entirely, with the one
    // relevant line placed at the very end — the shape an actively-growing
    // transcript has in practice, and the scenario the bound exists for.
    const padding = "x".repeat(2_000_000); // ~2 MB, well over the bound
    writeFileSync(path, `${padding}\nneedle-line\n`);
    const result = readBoundedTail(path, 1024);
    expect(result).toContain("needle-line");
    expect(result).not.toContain("xxxx");
    expect(result.length).toBeLessThan(padding.length);
  });
});

describe("forEachDirEntry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreach-dir-entry-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("visits every entry when onEntry always returns true, and reports the walk complete", () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `f${i}.txt`), "");
    }
    const seen: string[] = [];
    const complete = forEachDirEntry(dir, (entry) => {
      seen.push(entry.name);
      return true;
    });
    expect(seen.sort()).toEqual(
      ["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"].sort(),
    );
    expect(complete).toBe(true);
  });

  it("stops as soon as onEntry returns false, never visiting the rest, but still reports complete", () => {
    // The property `candidateFiles()`'s scan-count budget depends on: a
    // caller must be able to interrupt the walk mid-directory, not merely
    // between whole directories — proving `readdirSync`'s eager
    // materialize-then-iterate could not offer this at all.
    // A caller-chosen early stop is
    // not an I/O failure — the caller's own `truncated` bookkeeping (e.g.
    // the budget check) is what records THAT; this return value answers a
    // narrower question, whether the walk itself could still read the
    // directory.
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, `f${i}.txt`), "");
    }
    let count = 0;
    const complete = forEachDirEntry(dir, () => {
      count++;
      return count < 3;
    });
    expect(count).toBe(3);
    expect(complete).toBe(true);
  });

  it("reports no entries and TRUE (not truncated) for a directory that does not exist", () => {
    // An absent root is a legitimate empty state — no vendor directory means
    // no sessions to find — not evidence the walk was cut short.
    let called = false;
    const complete = forEachDirEntry(join(dir, "missing"), () => {
      called = true;
      return true;
    });
    expect(called).toBe(false);
    expect(complete).toBe(true);
  });

  it("reports FALSE when the path exists but is not a directory", () => {
    // `opendirSync` on a regular file throws ENOTDIR, not ENOENT — a
    // materially different failure from "nothing here": something exists at
    // this path and could not be enumerated, which is exactly the case a
    // caller's `truncated` signal exists for. Before this fix,
    // `forEachDirEntry` treated every `opendirSync` failure identically to a
    // missing root and silently visited nothing.
    const notADir = join(dir, "notadir.txt");
    writeFileSync(notADir, "");
    let called = false;
    const complete = forEachDirEntry(notADir, () => {
      called = true;
      return true;
    });
    expect(called).toBe(false);
    expect(complete).toBe(false);
  });

  // A `readSync` failure mid-walk (EIO, a device vanishing, ...) is handled
  // by the same `catch { return false; }` shape as the `opendirSync` case
  // above, but is not separately pinned here: both the Node and Bun runtimes
  // this module targets buffer an entire small-to-medium directory listing
  // on the FIRST `readSync` call, so removing the directory after visiting
  // one entry (the only portable way to force a read failure, without
  // permission games that behave inconsistently when tests run as root)
  // does not reproduce a failure — confirmed empirically up to 50 entries.
  // The branch is exercised by the SAME code path the `opendirSync` test
  // above verifies (an unconditional `false` on any caught error), not by a
  // distinct implementation this test suite could silently stop covering.
});

describe("isConfirmedAbsence", () => {
  // A pure function precisely so this classification is pinned directly,
  // without needing to reproduce a real EACCES/ELOOP failure on disk —
  // exactly the "permission games that behave inconsistently when tests run
  // as root" trap the `forEachDirEntry` comment above already avoids.
  it("is true for a confirmed ENOENT", () => {
    expect(
      isConfirmedAbsence(Object.assign(new Error("gone"), { code: "ENOENT" })),
    ).toBe(true);
  });

  it.each([
    ["EACCES — permission denied, not confirmed absence", "EACCES"],
    ["ELOOP — e.g. a symlink cycle, not confirmed absence", "ELOOP"],
    ["EIO — a degraded device, not confirmed absence", "EIO"],
  ])("is false for %s", (_label, code) => {
    expect(isConfirmedAbsence(Object.assign(new Error("x"), { code }))).toBe(
      false,
    );
  });

  it("is false for an error with no .code at all", () => {
    expect(isConfirmedAbsence(new Error("unknown failure"))).toBe(false);
  });

  it("is false for a non-Error thrown value", () => {
    expect(isConfirmedAbsence("a string was thrown")).toBe(false);
    expect(isConfirmedAbsence(null)).toBe(false);
    expect(isConfirmedAbsence(undefined)).toBe(false);
  });
});

describe("scanBudgetExceeded", () => {
  // A pure function on purpose (types.ts's own doc comment): the two
  // `candidateFiles()` circuit breakers — entry count and wall-clock
  // duration — must be tested deterministically, without manufacturing
  // MAX_CANDIDATE_FILES_SCANNED files or waiting real milliseconds for a
  // timer to elapse.
  it("is false when neither the count nor the deadline has been reached", () => {
    expect(scanBudgetExceeded(5, 10, 1_000, 500)).toBe(false);
  });

  it("is true once scanned reaches the count cap, however far off the deadline is", () => {
    expect(scanBudgetExceeded(10, 10, 1_000_000, 0)).toBe(true);
  });

  it("is true once now reaches the deadline, however few entries were scanned", () => {
    expect(scanBudgetExceeded(0, 10, 1_000, 1_000)).toBe(true);
  });

  it("is true past either bound, not just at it", () => {
    expect(scanBudgetExceeded(11, 10, 1_000, 500)).toBe(true);
    expect(scanBudgetExceeded(0, 10, 1_000, 1_001)).toBe(true);
  });
});

describe("maxCandidateScanMs", () => {
  it("defaults to a positive number of milliseconds with no override", () => {
    expect(maxCandidateScanMs()).toBeGreaterThan(0);
  });

  it("honours a well-formed DRIVE_PR_QUOTA_MAX_SCAN_MS override, including zero", () => {
    process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "0";
    expect(maxCandidateScanMs()).toBe(0);
    process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "250";
    expect(maxCandidateScanMs()).toBe(250);
  });

  it("falls back to the default on a malformed override rather than NaN", () => {
    const fallback = (() => {
      delete process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS;
      return maxCandidateScanMs();
    })();
    process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "-5";
    expect(maxCandidateScanMs()).toBe(fallback);
    process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "soon";
    expect(maxCandidateScanMs()).toBe(fallback);
  });
});

describe("claude adapter", () => {
  it("recognises the measured session-limit record as a SHORT window", () => {
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    const b = claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T16:40:00.000Z");
  });

  it("records only the RECOGNISED wording as evidence, never the raw message text", () => {
    // A message can bundle ordinary reply content in a SEPARATE block alongside
    // the vendor's own rate-limit notice block (the session-limit notice block
    // itself must be an EXACT match — so the reply content lives in its own
    // block here, not prefixed into the notice's own text as this test
    // originally had it). `evidence` is what drive.ts logs unattended to a
    // clone-wide log file, so it must carry only what was actually recognised
    // (the session-limit phrase, the `resets ...` clause), never whatever else
    // the user's transcript happened to contain.
    const secret = "the pentest finding about the internal admin endpoint";
    writeClaude("s.jsonl", [
      JSON.stringify({
        type: "assistant",
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        error: "rate_limit",
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        message: {
          content: [
            { type: "text", text: `Here is my analysis: ${secret}.` },
            {
              type: "text",
              text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
            },
          ],
        },
      }),
    ]);
    const b = claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.evidence).not.toContain(secret);
    expect(b?.evidence).toBe(
      "session limit · resets 6:40pm (Europe/Amsterdam)",
    );
  });

  it('ignores a record with error:"rate_limit" that lacks the documented API-error shape', () => {
    // `error: "rate_limit"` alone is not the documented discriminator set —
    // the measured record also always carries `isApiErrorMessage: true` and
    // `apiErrorStatus: 429`. A record that reuses the bare error string for
    // some other reason must not become authoritative telemetry.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
        isApiErrorMessage: false,
      }),
    ]);
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it('ignores a record with error:"rate_limit" whose apiErrorStatus is not 429', () => {
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
        apiErrorStatus: 500,
      }),
    ]);
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("classifies an UNRECOGNISED rate_limit wording as unknown and withholds the reset", () => {
    // No weekly wall exists in the measured corpus, so this pins the fail-closed
    // branch rather than a guess at the vendor's weekly wording. Note the text
    // carries a perfectly parseable reset clause and the adapter still refuses
    // it: an instant is useless without knowing the window's LENGTH, and length
    // is what decides sleepability.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your weekly limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    const b = claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("unknown");
    expect(b?.resetAt).toBeNull();
    expect(planFor(b as QuotaBlock, SINCE).action).toBe("stop");
  });

  it("does NOT borrow a reset clause from a DIFFERENT content block than the one naming session limit", () => {
    // Content blocks in the SAME message: the first incidentally mentions
    // "session limit" in ordinary reply content (no reset clause of its own);
    // the second is a genuinely different, unrecognised wall's own notice,
    // carrying a reset clause but never the phrase "session limit". Scanning
    // the JOIN of the blocks would classify this SHORT and borrow the second
    // block's reset time — sleeping the drive through the wrong wall entirely.
    // Classification must be decided
    // from a single block, so the phrase-matching block's OWN (absent) reset
    // clause is what counts — never the other block's.
    writeClaude("s.jsonl", [
      JSON.stringify({
        type: "assistant",
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        error: "rate_limit",
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        message: {
          content: [
            {
              type: "text",
              text: "Reminder: your session limit resets periodically as you work.",
            },
            {
              type: "text",
              text: "You've hit your weekly limit · resets 6:40pm (Europe/Amsterdam)",
            },
          ],
        },
      }),
    ]);
    const b = claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.resetAt).toBeNull();
  });

  it('does NOT classify a QUALIFIED same-block phrase ("weekly session limit") as the known SHORT wording', () => {
    // A bare `session limit` substring test matches this too, even though
    // the wall is a different (weekly) one the adapter has never actually
    // observed — a false SHORT classification with a genuinely-parseable,
    // and therefore sleepable, reset time from the SAME block (unlike the
    // cross-block test above, this is a single-block false positive).
    // Must match the complete
    // measured wording, not a substring of it.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your weekly session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    const b = claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("unknown");
    expect(b?.resetAt).toBeNull();
  });

  it('does NOT classify a phrase with a qualifier AFTER "session limit" as the known SHORT wording', () => {
    // The prefix-qualifier fix anchored the START of the phrase but not its
    // END, so a qualifier appended between the phrase and the reset clause —
    // "session limit for the week · resets …" — still matched: a different,
    // unrecognised (weekly-like) wall wearing the recognised phrase. The phrase
    // must transition DIRECTLY into "resets" with nothing else between.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit for the week · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    const b = claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("unknown");
    expect(b?.resetAt).toBeNull();
  });

  it("does NOT classify a phrase with a qualifier AFTER the reset clause as the known SHORT wording", () => {
    // An earlier fix anchored the phrase through "resets" but not past the
    // reset clause itself, so trailing text after it — "resets 6:40pm
    // (Europe/Amsterdam) FOR THE WEEK" — still matched and yielded a sleepable
    // reset for wording that qualifies the wall as weekly. The whole block must
    // be EXACTLY the phrase plus the reset clause, nothing more.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam) for the week",
      }),
    ]);
    const b = claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("unknown");
    expect(b?.resetAt).toBeNull();
  });

  it("recognises the exact measured notice with no leading or trailing whitespace variance", () => {
    // The positive case for the full-anchor fix — the exact measured wording
    // must still classify correctly, not merely reject everything else.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    const b = claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T16:40:00.000Z");
  });

  it.each([
    // Open paren, no close — the zone consumes to the exact end of the
    // string, so the outer `$` anchor was satisfied by the OLD independently
    // -optional `\(?...\)?` pattern even though the clause is malformed.
    "You've hit your session limit · resets 6:40pm (Europe/Amsterdam",
    // Bare zone, no open paren, but a stray trailing `)` — the bare-zone branch
    // matches "Europe/Amsterdam", and since the OLD pattern's closing paren was
    // independently optional, the leftover `)` was simply left over rather than
    // failing the match.
    "You've hit your session limit · resets 6:40pm Europe/Amsterdam)",
  ])(
    "does NOT classify a notice with MISMATCHED parentheses around the zone as the known SHORT wording: %p",
    (text) => {
      writeClaude("s.jsonl", [
        claudeWall({ cwd: CWD, timestamp: "2026-08-20T12:30:00.000Z", text }),
      ]);
      const b = claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
      expect(b?.window).toBe("unknown");
      expect(b?.resetAt).toBeNull();
    },
  );

  it('ignores a record whose outer type is not "assistant", even with compatible error fields', () => {
    // The Codex adapter validates its outer envelope (`type: "event_msg"`)
    // for the identical reason: without it, a different transcript record
    // type carrying compatible error/isApiErrorMessage/apiErrorStatus/cwd/
    // timestamp/text fields becomes authoritative account telemetry too.
    writeClaude("s.jsonl", [
      JSON.stringify({
        type: "some_other_record_type",
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        error: "rate_limit",
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        message: {
          content: [
            {
              type: "text",
              text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
            },
          ],
        },
      }),
    ]);
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("ignores a wall from a SIBLING worktree", () => {
    // The dominant shape on this machine: many Conductor worktrees, one
    // account. Without the cwd check every drive reads every other drive's wall.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: OTHER_CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("recognises a wall recorded from a SUBDIRECTORY of the worktree", () => {
    // The transcript records the session's CURRENT directory, so an agent that
    // cd'd mid-round writes a deeper path. Missing that costs the drive the
    // sleep it was entitled to.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: `${CWD}/apps/backend`,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW })?.window,
    ).toBe("short");
  });

  it("recognises a BACKSLASH-separated subdirectory (Windows-style cwd)", () => {
    // A hard-coded `/` prefix never matches a backslash-separated path, even
    // when the worktree itself is expressed with forward slashes (as this
    // fixture's CWD constant is) — nothing guarantees the transcript's own
    // `cwd` shares that convention.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: `${CWD}\\apps\\backend`,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW })?.window,
    ).toBe("short");
  });

  it("matches when the worktree and record cwd use DIFFERENT separator conventions from each other", () => {
    // worktree is backslash-only, record cwd is forward-slash-only. Trying
    // each separator against the whole unnormalized string (the prior
    // revision) fails both ways, since neither side is internally consistent
    // with the OTHER — nothing here ever promised the two sides agree on a
    // convention.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: "C:/repo/alpha/apps/backend",
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    expect(
      claudeAdapter.detect({ cwd: "C:\\repo\\alpha", since: SINCE, now: NOW })
        ?.window,
    ).toBe("short");
  });

  it("matches case-insensitively on Windows, but NOT on POSIX", () => {
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: "/Users/dev/workspaces/proj/Alpha/apps/backend",
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    const savedPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      expect(
        claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW })?.window,
      ).toBe("short");

      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      expect(
        claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
      ).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", {
        value: savedPlatform,
        configurable: true,
      });
    }
  });

  it("does NOT match a sibling worktree whose path merely shares a prefix", () => {
    // Conductor worktrees are siblings under one parent, so the separator in
    // the prefix test is what stops `/…/alpha` from swallowing `/…/alpha-v2`.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: `${CWD}-v2`,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("ignores a wall from BEFORE this pass started", () => {
    // Without the floor, a drive re-armed after an earlier wall re-reads that
    // wall as its own and parks itself again, indefinitely.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T11:00:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("accepts a wall truncated to whole-second precision in the SAME second the pass started", () => {
    // `since` (passStartedAt in drive.ts) is millisecond-precise; the measured
    // record shape's own `timestamp` field is not, and some runner filesystems
    // expose the transcript mtime at the same coarse precision. A pass started
    // at 12:00:00.884Z can produce a wall whose record timestamp AND file
    // mtime read as 12:00:00.000Z — genuinely at or after the pass start, not
    // before it — and a millisecond-exact floor would wrongly reject it.
    const sinceWithMs = new Date("2026-08-20T12:00:00.884Z");
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:00:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    const transcript = join(
      root,
      "claude",
      "-Users-dev-workspaces-proj-alpha",
      "s.jsonl",
    );
    const coarseMtime = new Date("2026-08-20T12:00:00.000Z");
    utimesSync(transcript, coarseMtime, coarseMtime);
    expect(
      claudeAdapter.detect({ cwd: CWD, since: sinceWithMs, now: NOW })?.window,
    ).toBe("short");
  });

  it("ignores a FUTURE-dated record beyond clock-skew slack", () => {
    // A corrupted write or a skewed container clock would otherwise satisfy
    // `ts >= since` on every later pass for as long as the file keeps being
    // written to, permanently winning the "newest wall" comparison and
    // attributing an unrelated pass failure to stale evidence.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T14:30:00.000Z", // 30 min after NOW
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("tolerates a small clock-skew allowance on an otherwise-future record", () => {
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T14:02:00.000Z", // 2 min after NOW
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW })?.window,
    ).toBe("short");
  });

  it("takes the NEWEST wall when a pass hit several", () => {
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 4:00pm (Europe/Amsterdam)",
      }),
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T13:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    expect(
      claudeAdapter
        .detect({ cwd: CWD, since: SINCE, now: NOW })
        ?.resetAt?.toISOString(),
    ).toBe("2026-08-20T16:40:00.000Z");
  });

  it("prefers a LATER same-second record in the SAME file over an earlier one", () => {
    // Claude's whole-second timestamp precision means two genuinely distinct
    // records — a retry within the same second — can round to the identical
    // displayed second. A strict `<=` rejected the second one outright, leaving
    // the first (SHORT, sleepable) record standing over a later, more
    // restrictive (weekly-like, fail-closed) one recorded moments afterward in
    // the SAME file. This file's own line order is real chronological evidence
    // for the tie.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 4:00pm (Europe/Amsterdam)",
      }),
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your weekly limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    const b = claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("unknown");
    expect(b?.resetAt).toBeNull();
  });

  it("survives a torn final line without losing an earlier valid record", () => {
    // A transcript being written while the pass dies. The torn line must be
    // skipped, not turn the whole scan into "nothing found".
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
      '{"type":"assistant","error":"rate_limit","cwd":"/Users/dev/wo',
    ]);
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW })?.window,
    ).toBe("short");
  });

  it("reports nothing when the projects directory does not exist", () => {
    process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR = join(root, "absent");
    expect(() =>
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).not.toThrow();
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("falls back to $CLAUDE_CONFIG_DIR/projects when no test override is set", () => {
    // An execution service may provision a per-slot config home via
    // CLAUDE_CONFIG_DIR outside the worktree. Without this fallback the adapter
    // always looks at ~/.claude/projects and never finds a transcript written
    // under a provisioned home.
    delete process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR;
    const configDir = join(root, "provisioned-claude-home");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const dir = join(configDir, "projects", "-Users-dev-workspaces-proj-alpha");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "s.jsonl"),
      `${claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      })}\n`,
    );
    expect(
      claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW })?.window,
    ).toBe("short");
  });
});

describe("codex adapter", () => {
  // No Codex wall was ever reached in the measured corpus, so every case here
  // is a constructed record in the SHAPE the corpus proves — the envelope, the
  // field names, and the observed window sizes are transcribed; only the
  // exhaustion is synthetic.
  it("recognises exhaustion by used_percent on the short window", () => {
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: window(40, 10080, "2026-08-24T00:00:00.000Z"),
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T15:00:00.000Z");
  });

  it("a later HEALTHY event clears an earlier exhausted candidate in the same file", () => {
    // A `token_count` event is written on every turn. A pass that hit a wall
    // and then recovered (the short window reopened) writes a healthy event
    // after the exhausted one — that must clear the stale candidate, or an
    // unrelated LATER pass failure reads as still hitting a wall the account
    // had already recovered from.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T13:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
      {
        timestamp: "2026-08-20T13:05:00.000Z", // after the window's own reset
        rate_limits: {
          limit_id: "codex",
          primary: window(2, 300, "2026-08-20T18:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    expect(
      codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("does NOT let a malformed used_percent masquerade as recovery", () => {
    // A later record with a non-numeric used_percent (e.g. a string "100") used
    // to default to 0 in readWindow(), which the "clear on healthy" logic would
    // then read as proof the account recovered — clearing a real, earlier
    // exhausted candidate on malformed telemetry.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T13:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
      {
        timestamp: "2026-08-20T12:35:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: {
            used_percent: "100", // malformed: a string, not a number
            window_minutes: 300,
            resets_at: Math.floor(
              Date.parse("2026-08-20T13:00:00.000Z") / 1000,
            ),
          },
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T13:00:00.000Z");
  });

  it("does NOT clear a real exhausted block when only PART of a healthy-looking record parsed", () => {
    // secondary is exhausted (weekly). A later event has a genuinely healthy
    // primary, but its OWN secondary is present-but-malformed (not null —
    // readWindow() rejects it) — the unreadable slot could still be
    // exhausted, so rate_limit_reached_type: null must not be read as
    // confirmed recovery here.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(20, 300, "2026-08-20T15:00:00.000Z"),
          secondary: window(100, 10080, "2026-08-27T00:00:00.000Z"),
          rate_limit_reached_type: null,
        },
      },
      {
        timestamp: "2026-08-20T12:35:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(10, 300, "2026-08-20T15:30:00.000Z"),
          secondary: { used_percent: 50 }, // present but missing window_minutes/resets_at
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("weekly");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });

  it("fails closed to an unknown block on a readable-exhausted slot when its sibling is unreadable", () => {
    // primary is genuinely exhausted (short, 300min) AND readable, but
    // secondary is present-but-malformed, and nothing names a
    // rate_limit_reached_type. The unreadable secondary could be an
    // exhausted WEEKLY window, so the readable short window must not become
    // a confident `hit` with a guessed reset — but it IS positive evidence a
    // wall exists, and discarding that to `null` would let the driver treat
    // a real quota wall as a generic pass failure instead of the promised
    // unknown/QUOTA_PARKED block.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: { used_percent: 50 }, // present but missing window_minutes/resets_at
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("unknown");
    expect(b?.resetAt).toBeNull();
  });

  it("fails closed instead of trusting a NAMED window when its sibling is unreadable", () => {
    // rate_limit_reached_type names `primary`, which IS readable and
    // exhausted — but secondary is present-but-malformed. The unreadable
    // secondary could be an exhausted weekly window; the named short window
    // must not become a confident `hit` on the strength of naming alone.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: { used_percent: 50 }, // present but missing window_minutes/resets_at
          rate_limit_reached_type: "primary",
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("unknown");
    expect(b?.resetAt).toBeNull();
  });

  it("does NOT discard a positive rate_limit_reached_type signal when BOTH windows are unreadable", () => {
    // Both primary and secondary fail to parse, so `windows` is empty — but
    // rate_limit_reached_type still names a real wall. Bailing out before
    // reading that field would silently drop a genuine quota signal to a
    // generic pass failure instead of the promised unknown/QUOTA_PARKED
    // block.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 100 }, // no window_minutes/resets_at
          secondary: { used_percent: 100 }, // no window_minutes/resets_at
          rate_limit_reached_type: "primary",
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("unknown");
    expect(b?.resetAt).toBeNull();
  });

  it("prefers a LATER same-timestamp event in the SAME rollout over an earlier one", () => {
    // This file's own header comment concedes rollout timestamp precision
    // "is not guaranteed" — a strict `ts <= newestAt` discarded every later
    // conclusive event sharing a timestamp with the current newest, so a
    // 100%-used event immediately followed by a healthy retry recorded at
    // the identical timestamp left the exhausted block standing instead of
    // clearing it. This rollout's own
    // append-only line order is real evidence for the tie.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T13:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(5, 10080, "2026-08-27T00:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    expect(
      codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("does NOT let an INCONCLUSIVE record poison newestAt", () => {
    // Written FIRST despite carrying the LATER timestamp — line order within
    // one file is deterministic (unlike cross-file readdirSync order, which
    // this filesystem does not return alphabetically), so this reliably
    // exercises "an inconclusive record is processed before a genuinely
    // valid, older-timestamped one." If the inconclusive record advanced
    // newestAt anyway, the valid record would be skipped by `ts <= newestAt`.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T13:00:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(10, 300, "2026-08-20T15:30:00.000Z"),
          secondary: { used_percent: 50 }, // present but unreadable — inconclusive
          rate_limit_reached_type: null,
        },
      },
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T15:00:00.000Z");
  });

  it("does NOT let an out-of-range used_percent masquerade as recovery", () => {
    // -1 is finite, so the finite check alone lets it through; it is never >=
    // 100 (so mostRestrictiveExhausted never selects it) but it also satisfies
    // the healthy branch, clearing a real exhausted candidate.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T13:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
      {
        timestamp: "2026-08-20T12:35:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: {
            used_percent: -1,
            window_minutes: 300,
            resets_at: Math.floor(
              Date.parse("2026-08-20T18:00:00.000Z") / 1000,
            ),
          },
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T13:00:00.000Z");
  });

  it("does NOT let a malformed window_minutes masquerade as recovery", () => {
    // Same class as the malformed used_percent case, on the other numeric
    // field: `0` is a syntactically valid, JSON-round-trippable number (NaN
    // and Infinity both collapse to `null` in JSON, so they can never reach
    // readWindow() as numbers at all) that a bare `typeof === 'number'`
    // check accepts, produces no exhausted candidate, and would otherwise
    // clear a real earlier quota block as purportedly healthy.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T13:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
      {
        timestamp: "2026-08-20T12:35:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: {
            used_percent: 2,
            window_minutes: 0,
            resets_at: Math.floor(
              Date.parse("2026-08-20T18:00:00.000Z") / 1000,
            ),
          },
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T13:00:00.000Z");
  });

  it("classifies by window_minutes, NOT by the primary/secondary slot", () => {
    // Measured: older rollouts put the 300-minute window in `primary`, newer
    // ones put the 10080-minute one there with `secondary` null. A driver that
    // read "primary" as "the short window" would sleep on a weekly wall.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 10080, "2026-08-27T00:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("weekly");
    expect(planFor(b as QuotaBlock, SINCE).action).toBe("stop");
  });

  const WINDOW_SIZES: Array<[number, QuotaWindow]> = [
    [299, "short"],
    [300, "short"],
    [10079, "weekly"],
    [10080, "weekly"],
  ];
  it.each(WINDOW_SIZES)(
    "treats a %p-minute window as %p — the server reports a window already ticking",
    (minutes, expected) => {
      writeCodex("r.jsonl", CWD, [
        {
          timestamp: "2026-08-20T12:30:00.000Z",
          rate_limits: {
            limit_id: "codex",
            primary: window(100, minutes, "2026-08-20T15:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      ]);
      expect(
        codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW })?.window,
      ).toBe(expected);
    },
  );

  it("honours rate_limit_reached_type when the vendor names the window", () => {
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(12, 300, "2026-08-20T15:00:00.000Z"),
          secondary: window(99, 10080, "2026-08-27T00:00:00.000Z"),
          rate_limit_reached_type: "secondary",
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    // Neither window is at 100%, so percentage alone would have found nothing;
    // the named field is what makes this a block, and it names the weekly one.
    expect(b?.window).toBe("weekly");
  });

  it.each([
    ["missing entirely", undefined],
    ["false", false],
    ["a number", 42],
  ])(
    "does NOT read rate_limit_reached_type: %s as the healthy sentinel",
    (_label, malformedReachedType) => {
      // Only exact `null` is the vendor's documented healthy sentinel.
      // Missing, `false`, and a number all satisfied the old `!limitReached`
      // check the same way `null` legitimately does — leave the earlier
      // exhausted candidate standing instead of clearing it on no confirmed
      // signal either way.
      const secondPayload: Record<string, unknown> = {
        type: "token_count",
        info: {},
        rate_limits: {
          limit_id: "codex",
          primary: window(2, 300, "2026-08-20T18:00:00.000Z"),
          secondary: null,
        },
      };
      if (malformedReachedType !== undefined) {
        (
          secondPayload.rate_limits as Record<string, unknown>
        ).rate_limit_reached_type = malformedReachedType;
      }
      writeCodexRaw("r.jsonl", CWD, [
        {
          timestamp: "2026-08-20T12:30:00.000Z",
          payload: {
            type: "token_count",
            info: {},
            rate_limits: {
              limit_id: "codex",
              primary: window(100, 300, "2026-08-20T13:00:00.000Z"),
              secondary: null,
              rate_limit_reached_type: null,
            },
          },
        },
        {
          timestamp: "2026-08-20T12:35:00.000Z",
          payload: secondPayload,
        },
      ]);
      const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
      expect(b?.window).toBe("short");
      expect(b?.resetAt?.toISOString()).toBe("2026-08-20T13:00:00.000Z");
    },
  );

  it("prefers an ALSO-exhausted weekly window over a named short slot", () => {
    // rate_limit_reached_type names `primary` (the short window, itself
    // exhausted), but `secondary` (weekly) is ALSO exhausted. Sleeping until
    // the named short window's reset would be wrong: the weekly wall still
    // blocks every retry after that.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: window(100, 10080, "2026-08-27T00:00:00.000Z"),
          rate_limit_reached_type: "primary",
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("weekly");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });

  it("does not let a NEWER malformed record in another file block an OLDER valid one", () => {
    // `readdirSync` file order is not a chronological contract. A malformed
    // record (both windows unreadable) carries a NEWER timestamp than a
    // genuinely valid exhausted record in a DIFFERENT file. If the malformed
    // one were processed first and allowed to advance the authoritative
    // timestamp before its own validity was confirmed, the valid, older
    // record would be skipped by the `ts <= newestAt` guard and the real
    // block would be lost entirely.
    writeCodex("a-malformed.jsonl", CWD, [
      {
        timestamp: "2026-08-20T13:00:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 100 }, // no window_minutes/resets_at
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    writeCodex("b-valid.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T15:00:00.000Z");
  });

  it("does NOT select a healthy window for an unrecognised rate_limit_reached_type", () => {
    // The vendor says a limit was reached, but names a window value neither
    // "primary" nor "secondary" — and neither window is at 100%. Falling
    // through to `windows[0]` would read this healthy primary window as the
    // exhausted one and hand back a real, sleepable resetAt.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(12, 300, "2026-08-20T15:00:00.000Z"),
          secondary: window(40, 10080, "2026-08-27T00:00:00.000Z"),
          rate_limit_reached_type: "future_vendor_value",
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("unknown");
    expect(b?.resetAt).toBeNull();
    expect(planFor(b as QuotaBlock, SINCE).action).toBe("stop");
  });

  it("does NOT suppress a real 100% exhaustion signal for an unrecognised rate_limit_reached_type", () => {
    // The unrecognised name must not suppress a real percentage-based
    // exhaustion signal either — it is only a fallback for when neither
    // window measures 100%.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: window(40, 10080, "2026-08-27T00:00:00.000Z"),
          rate_limit_reached_type: "future_vendor_value",
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T15:00:00.000Z");
  });

  it("does NOT select a healthy sibling window when the NAMED slot is malformed", () => {
    // rate_limit_reached_type: 'primary' names a slot whose own record is
    // malformed (no resets_at), and the only OTHER window is healthy at 20%.
    // Falling through to `windows[0]` — the sole surviving element after the
    // malformed primary is filtered out — would select that healthy window
    // and report it as if it were the one that closed.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 100, window_minutes: 300 }, // no resets_at
          secondary: window(20, 10080, "2026-08-27T00:00:00.000Z"),
          rate_limit_reached_type: "primary",
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("unknown");
    expect(b?.resetAt).toBeNull();
    expect(planFor(b as QuotaBlock, NOW).action).toBe("stop");
  });

  it("rejects a resets_at outside the representable Date range rather than crashing", () => {
    // A syntactically valid JSON number (1e300) produces an Invalid Date;
    // without validation this window is selected, `resetAt` is an Invalid
    // Date, and a later `toISOString()` throws inside a pass-failure handler
    // instead of a clean QUOTA_PARKED.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 100, window_minutes: 300, resets_at: 1e300 },
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    expect(
      codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("reports NO block for a healthy account", () => {
    // A `token_count` event is written on EVERY turn, so the overwhelmingly
    // common case is a rate_limits record describing an account that is fine.
    // Reading one of those as a wall would park every drive on every round.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(20, 10080, "2026-08-27T00:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    expect(
      codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("ignores a NEWER event whose payload.type is not token_count, even with a compatible rate_limits shape", () => {
    // A different event type with a similarly-shaped rate_limits property
    // must not become authoritative telemetry — it could otherwise clear a
    // real exhausted block as healthy or, in the opposite direction, park an
    // unrelated pass failure.
    writeCodexRaw("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        payload: {
          type: "token_count",
          info: {},
          rate_limits: {
            limit_id: "codex",
            primary: window(100, 300, "2026-08-20T13:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      },
      {
        timestamp: "2026-08-20T12:35:00.000Z",
        payload: {
          type: "some_other_event",
          rate_limits: {
            limit_id: "codex",
            primary: window(2, 300, "2026-08-20T18:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T13:00:00.000Z");
  });

  it("ignores a NEWER token_count event whose limit_id is not codex", () => {
    writeCodexRaw("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        payload: {
          type: "token_count",
          info: {},
          rate_limits: {
            limit_id: "codex",
            primary: window(100, 300, "2026-08-20T13:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      },
      {
        timestamp: "2026-08-20T12:35:00.000Z",
        payload: {
          type: "token_count",
          info: {},
          rate_limits: {
            limit_id: "some_other_product",
            primary: window(2, 300, "2026-08-20T18:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T13:00:00.000Z");
  });

  it("ignores a NEWER record whose OUTER type is not event_msg, even with a compatible payload", () => {
    // The documented envelope is `type: "event_msg"` wrapping the
    // `token_count` payload. A record of some OTHER outer type carrying a
    // similarly-shaped payload must not become authoritative telemetry
    // either — the inner `payload.type`/`limit_id` checks narrow WHICH
    // payload inside an already-recognised envelope, they do not recognise
    // the envelope itself.
    writeCodexRaw("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {},
          rate_limits: {
            limit_id: "codex",
            primary: window(100, 300, "2026-08-20T13:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      },
      {
        timestamp: "2026-08-20T12:35:00.000Z",
        type: "some_other_envelope",
        payload: {
          type: "token_count",
          info: {},
          rate_limits: {
            limit_id: "codex",
            primary: window(2, 300, "2026-08-20T18:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T13:00:00.000Z");
  });

  it("accepts an event truncated to whole-second precision in the SAME second the pass started", () => {
    // Same defensive symmetry as the Claude adapter's identical record and
    // file-mtime floor.
    const sinceWithMs = new Date("2026-08-20T12:30:00.884Z");
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    const rollout = join(root, "codex", "2026", "08", "20", "r.jsonl");
    const coarseMtime = new Date("2026-08-20T12:30:00.000Z");
    utimesSync(rollout, coarseMtime, coarseMtime);
    const b = codexAdapter.detect({ cwd: CWD, since: sinceWithMs, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T15:00:00.000Z");
  });

  it("ignores a rollout from a sibling worktree", () => {
    writeCodex("r.jsonl", OTHER_CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    expect(
      codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("recognises a rollout recorded from a SUBDIRECTORY of the worktree", () => {
    // A pass wrapper that `cd`s into a subdirectory before starting Codex
    // (e.g. `sh -c 'cd apps/backend && codex exec …'`) records the deeper
    // path in the rollout's own session metadata. Strict equality against
    // `opts.cwd` would miss it — the Claude adapter already widens for the
    // identical reason.
    writeCodex("r.jsonl", `${CWD}/apps/backend`, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
  });

  it("does NOT match a sibling worktree whose path merely shares a prefix (Codex)", () => {
    writeCodex("r.jsonl", `${CWD}-v2`, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    expect(
      codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("ignores a FUTURE-dated rollout event beyond clock-skew slack", () => {
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T14:30:00.000Z", // 30 min after NOW
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    expect(
      codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
    ).toBeNull();
  });

  it("selects the most RESTRICTIVE exhausted window, not array order", () => {
    // Measured shape: older rollouts put the short window in `primary` and
    // the weekly one in `secondary`. With rate_limit_reached_type null and
    // BOTH windows at 100%, array-order `.find()` picks the short window and
    // sleeps the drive through it while the weekly wall — the one actually
    // blocking every retry — still stands.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: window(100, 10080, "2026-08-27T00:00:00.000Z"),
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("weekly");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });

  it("selects the most restrictive exhausted window even in the OPPOSITE slot order", () => {
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 10080, "2026-08-27T00:00:00.000Z"),
          secondary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("weekly");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });

  it("falls back to $CODEX_HOME/sessions when no test override is set", () => {
    // Same factory-provisioned-home fallback as the Claude adapter's
    // CLAUDE_CONFIG_DIR handling.
    delete process.env.DRIVE_PR_CODEX_SESSIONS_DIR;
    const codexHome = join(root, "provisioned-codex-home");
    process.env.CODEX_HOME = codexHome;
    const dir = join(codexHome, "sessions", "2026", "08", "20");
    mkdirSync(dir, { recursive: true });
    const head = JSON.stringify({
      timestamp: "2026-08-20T10:00:00.000Z",
      type: "session_meta",
      payload: { cwd: CWD, id: "x", cli_version: "0.144.6" },
    });
    const body = JSON.stringify({
      timestamp: "2026-08-20T12:30:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {},
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    });
    writeFileSync(join(dir, "r.jsonl"), `${[head, body].join("\n")}\n`);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
  });

  it("still resolves the cwd, and finds a wall, in a rollout larger than the read bound", () => {
    // The `session_meta` head line lives at byte 0; the bounded tail read
    // used for the BODY no longer contains it once the file exceeds the
    // bound. If the cwd were (mis)derived from that tail instead of a
    // dedicated head-line read, this rollout would silently read as
    // belonging to no worktree at all.
    const junkPayload = {
      type: "user_input",
      // Padding well past the 8 MiB tail-read bound, on an event this
      // adapter never matches (`type` is neither `token_count` nor
      // `event_msg`'s own recognised shape) — present purely to make the
      // FILE large, not to be read as telemetry.
      junk: "x".repeat(9_000_000),
    };
    writeCodexRaw("r.jsonl", CWD, [
      { timestamp: "2026-08-20T11:00:00.000Z", payload: junkPayload },
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        payload: {
          type: "token_count",
          info: {},
          rate_limits: {
            limit_id: "codex",
            primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      },
    ]);
    const b = codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.window).toBe("short");
    expect(b?.resetAt?.toISOString()).toBe("2026-08-20T15:00:00.000Z");
  });
});

describe("the sleep/stop decision", () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  const block = (over: Partial<QuotaBlock>): QuotaBlock => ({
    vendor: "test",
    window: "short",
    resetAt: new Date("2026-08-20T14:00:00.000Z"),
    observedAt: new Date("2026-08-20T12:00:00.000Z"),
    evidence: "e",
    source: "s",
    ...over,
  });

  it("sleeps through a short window inside the bound", () => {
    const plan = planFor(block({}), now);
    expect(plan.action).toBe("sleep");
    if (plan.action === "sleep") expect(plan.ms).toBe(2 * 60 * 60 * 1000);
  });

  // Each of these is a way to strand an unattended drive for hours or days if
  // it resolved the other way, which is why they are all pinned as `stop`.
  it.each([
    ["a weekly window", block({ window: "weekly" })],
    ["an unclassifiable window", block({ window: "unknown" })],
    ["an unresolved reset", block({ resetAt: null })],
    [
      "a reset beyond the sleep bound",
      block({ resetAt: new Date("2026-08-20T23:00:00.000Z") }),
    ],
  ])("stops on %s", (_label, b) => {
    expect(planFor(b, now).action).toBe("stop");
  });

  it("sleeps (0ms) rather than stopping on a reset already in the past", () => {
    // The window is open RIGHT NOW — there is nothing to wait for, and
    // requiring an operator to re-arm the drive by hand for a wall that has
    // already cleared defeats the point of sleeping through a short window
    // unattended. This is also what makes `nextWallClock()`'s
    // minute-granularity fix actually land: a reset resolved to the CURRENT
    // minute can sit a few seconds behind `now`, and that must retry
    // immediately, not park.
    const plan = planFor(
      block({ resetAt: new Date("2026-08-20T11:00:00.000Z") }),
      now,
    );
    expect(plan.action).toBe("sleep");
    if (plan.action === "sleep") expect(plan.ms).toBe(0);
  });

  it("honours $DRIVE_PR_QUOTA_MAX_SLEEP_SEC", () => {
    process.env.DRIVE_PR_QUOTA_MAX_SLEEP_SEC = "600";
    expect(planFor(block({}), now).action).toBe("stop");
  });

  it("falls back to the default cap rather than overflowing setTimeout", () => {
    // `sleep()` forwards a resolved `ms` to `node:timers/promises`' setTimeout,
    // a 32-bit signed millisecond delay. An override this large would let a
    // legitimately far-future reset pass the cap uncapped, and the timer would
    // then fire immediately instead of after the real wait — the drive waking
    // mid-wall.
    process.env.DRIVE_PR_QUOTA_MAX_SLEEP_SEC = "999999999";
    expect(maxSleepMs()).toBe(6 * 60 * 60 * 1000);
  });

  it("accepts the largest representable cap in whole seconds", () => {
    process.env.DRIVE_PR_QUOTA_MAX_SLEEP_SEC = "2147483";
    expect(maxSleepMs()).toBe(2147483 * 1000);
  });
});

describe("the registry", () => {
  it("probes every vendor rather than inferring one from the pass command", () => {
    // The pass is arbitrary argv, so there is nothing reliable to infer from.
    // A Codex wall must be found even though nothing named Codex was passed in.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T15:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    expect(detectQuotaBlock({ cwd: CWD, since: SINCE, now: NOW })?.vendor).toBe(
      "codex",
    );
  });

  it("reports nothing when no vendor saw a wall", () => {
    expect(detectQuotaBlock({ cwd: CWD, since: SINCE, now: NOW })).toBeNull();
  });

  it("on a TIE in observedAt, prefers the less sleepable block over adapter order", () => {
    // The adapters normalize to whole-second precision, so a genuine tie
    // across vendors is reachable. `ADAPTERS` lists Claude before Codex —
    // without a tie-break, array order alone would keep the sleepable Claude
    // short-window wall even though the Codex weekly wall, observed in the
    // very same second, still blocks every retry.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T13:00:00.000Z",
        text: "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T13:00:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 10080, "2026-08-27T00:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    const b = detectQuotaBlock({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.vendor).toBe("codex");
    expect(b?.window).toBe("weekly");
  });

  it("selects by OBSERVATION time, not resetAt — a newer unresolved wall beats an older resolved one", () => {
    // Codex block observed at 12:30 with a real, resolved resetAt.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 300, "2026-08-20T20:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    // Claude block observed LATER (13:00), but with unrecognised wording, so
    // resetAt is null. Comparing on resetAt (treated as 0) would always lose
    // to the codex block above regardless of which was actually seen last.
    writeClaude("s.jsonl", [
      claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T13:00:00.000Z",
        text: "You've hit your weekly limit · resets 6:40pm (Europe/Amsterdam)",
      }),
    ]);
    const b = detectQuotaBlock({ cwd: CWD, since: SINCE, now: NOW });
    expect(b?.vendor).toBe("claude");
    expect(b?.resetAt).toBeNull();
  });

  it("degrades only the vendor whose OWN pre-spawn snapshot truncated, not every adapter alike", () => {
    // The aggregate-flag defect: Codex's
    // candidate has no session-id correlation to fall back on, so it is only
    // trustworthy when Codex's OWN snapshot walk is known complete. Claude's
    // snapshot is the one reported truncated here; a shared boolean used to
    // make `detectQuotaBlock` discard the unrelated, fully-reliable Codex
    // candidate too.
    writeCodex("r.jsonl", CWD, [
      {
        timestamp: "2026-08-20T12:30:00.000Z",
        rate_limits: {
          limit_id: "codex",
          primary: window(100, 10080, "2026-08-27T12:00:00.000Z"),
          secondary: null,
          rate_limit_reached_type: null,
        },
      },
    ]);
    const preexistingSessions = new Set<string>();
    // The flat fallback field says "truncated" (the old, pre-fix behaviour
    // every adapter would have shared); `truncatedByVendor` says Codex's OWN
    // walk was NOT one of the truncated ones. A caller ignoring the map and
    // falling through to the flat field unconditionally would discard this
    // candidate exactly like the pre-fix aggregate boolean did.
    const opts = {
      cwd: CWD,
      since: SINCE,
      now: NOW,
      preexistingSessions,
      preexistingSessionsTruncated: true,
    };
    const truncatedByVendor = new Map([
      ["claude", true],
      ["codex", false],
    ]);
    expect(detectQuotaBlock(opts, truncatedByVendor)?.vendor).toBe("codex");
    // Sanity: omitting the per-vendor map falls back to the flat field for
    // every adapter, which discards this same Codex candidate — proving the
    // fixture actually exercises the override rather than a vacuous scenario.
    expect(detectQuotaBlock(opts)).toBeNull();
  });
});

/**
 * Binding evidence to the pass this driver actually spawned.
 *
 * The defect these pin is not a parse error — every adapter read its record
 * correctly. It is ATTRIBUTION: `cwd` + `since` accept any session in the
 * worktree, and "newest wall wins" then hands whichever one was seen last to
 * a pass that may have had nothing to do with it. A human's interactive
 * session sitting in the same worktree is the normal condition while a drive
 * runs — the drive locks exclude other DRIVERS, not a chat — so this is the
 * expected case, not an exotic one.
 *
 * Two mechanisms, tested separately because they close different halves:
 * `preexistingSessions` (every vendor, closes the session that started
 * BEFORE the pass) and `correlation` (Claude only, closes a session that
 * starts during the spawn window too).
 */
describe("binding evidence to the spawned pass", () => {
  const SHORT_WALL =
    "You've hit your session limit · resets 6:40pm (Europe/Amsterdam)";

  describe("prepareSpawn — minting an identity for the pass", () => {
    it("claims a bare `claude` command and inserts --session-id after argv[0]", () => {
      const prepared = prepareQuotaSpawn(["claude", "-p", "/drive-pr 123"], {});
      expect(prepared?.correlation.vendor).toBe("claude");
      expect(prepared?.argv).toEqual([
        "claude",
        "--session-id",
        prepared?.correlation.sessionId as string,
        "-p",
        "/drive-pr 123",
      ]);
    });

    it("claims an absolute path to the CLI, since that is how a real pass command names it", () => {
      const prepared = prepareQuotaSpawn(
        ["/Users/dev/.local/bin/claude", "-p", "go"],
        {},
      );
      expect(prepared?.correlation.vendor).toBe("claude");
      expect(prepared?.argv[0]).toBe("/Users/dev/.local/bin/claude");
    });

    it("leaves a WRAPPER script alone even when its name contains the CLI name", () => {
      // The basename must be the CLI, never merely contain it. Appending a
      // flag a wrapper does not parse turns every round into a usage error —
      // the one way this whole mechanism could stop a drive that would
      // otherwise have run.
      for (const cmd of ["./pass.sh", "claude-pass.sh", "my-claude-wrapper"]) {
        expect(prepareQuotaSpawn([cmd, "-p", "go"], {})).toBeNull();
      }
    });

    it.each([
      ["-r", ["claude", "-r", "abc", "-p", "go"]],
      ["-c", ["claude", "-c", "-p", "go"]],
      ["--fork-session", ["claude", "--fork-session", "-p", "go"]],
      // `--resume` paired with `--fork-session` mints a NEW id instead of
      // reusing the resumed one, so correlating on the resumed value would
      // name a session about to stop existing — still left alone.
      [
        "--resume with --fork-session",
        ["claude", "--resume", "abc", "--fork-session", "-p", "go"],
      ],
      // `--continue` paired with `--fork-session` mints a NEW id too — the
      // fork wins over the confirmed-resume treatment, same as above.
      [
        "--continue with --fork-session",
        ["claude", "--continue", "--fork-session", "-p", "go"],
      ],
      ["--cloud", ["claude", "--cloud", "-p", "go"]],
      ["--bg", ["claude", "--bg", "-p", "go"]],
      // Commander expands `-pr` to `-p -r`, so the conflict hides inside a
      // token that matches no whole-flag entry.
      ["a conflict bundled into a short-flag group", ["claude", "-pr", "abc"]],
      // Commander's ATTACHED-value short form. The digits in the session id
      // mean this matches no all-alphabetic bundle pattern either, so only
      // scanning leading letters catches it. Deliberately not extended to
      // read a value even though the flag is unambiguously `-r` here — the
      // long form's unambiguous syntax is the only one this adapter reads a
      // resume value from.
      [
        "a conflict in the attached-value short form",
        ["claude", "-r550e8400-e29b-41d4-a716-446655440000", "-p", "go"],
      ],
    ])(
      "leaves the command alone when it already carries %s",
      (_label, argv) => {
        expect(prepareQuotaSpawn(argv, {})).toBeNull();
      },
    );

    describe("--resume <value> — correlating on an EXISTING session rather than minting one", () => {
      it.each([
        [
          "the space-separated long form",
          ["claude", "--resume", "abc", "-p", "go"],
        ],
        [
          "the --resume=<id> equals form",
          ["claude", "--resume=abc", "-p", "go"],
        ],
      ])(
        "reads the resumed session id from %s, unchanged argv",
        (_label, argv) => {
          const prepared = prepareQuotaSpawn(argv, {});
          expect(prepared?.correlation).toEqual({
            vendor: "claude",
            sessionId: "abc",
          });
          // Never injects --session-id: that would hand the CLI two
          // conflicting session selectors.
          expect(prepared?.argv).toEqual(argv);
        },
      );

      it("does not consume the NEXT token as the resume value when it looks like a flag", () => {
        // `--resume` immediately followed by another option (no positional
        // value at all) reads as "no value" — the interactive-picker case —
        // not as if `-p` were the resumed session id. It still confirms the
        // vendor deliberately targets an existing session, though, so it now
        // falls into the no-exact-id correlation below rather than being
        // left fully alone.
        const prepared = prepareQuotaSpawn(
          ["claude", "--resume", "-p", "go"],
          {},
        );
        expect(prepared?.correlation).toEqual({
          vendor: "claude",
          sessionId: null,
        });
        expect(prepared?.argv).toEqual(["claude", "--resume", "-p", "go"]);
      });
    });

    describe("a caller-supplied --session-id — correlating on it directly", () => {
      // A caller that already passed `--session-id` used to be treated as an
      // outright conflict and correlate on nothing, even though the value it
      // supplies is exactly as exact a key as one this adapter would mint
      // itself — the value is read the same unambiguous way `--resume
      // <value>` is, and argv is left completely unchanged since there is
      // nothing to inject.
      it.each([
        [
          "the space-separated long form",
          ["claude", "--session-id", "abc", "-p", "go"],
        ],
        [
          "the --session-id=<id> equals form",
          ["claude", "--session-id=abc", "-p", "go"],
        ],
      ])(
        "reads the caller-supplied session id from %s, unchanged argv",
        (_label, argv) => {
          const prepared = prepareQuotaSpawn(argv, {});
          expect(prepared?.correlation).toEqual({
            vendor: "claude",
            sessionId: "abc",
          });
          expect(prepared?.argv).toEqual(argv);
        },
      );

      it("leaves the command alone when --session-id has no readable value", () => {
        expect(
          prepareQuotaSpawn(["claude", "--session-id", "-p", "go"], {}),
        ).toBeNull();
      });
    });

    describe("confirmed vendor, no exact id — --continue / a bare --resume", () => {
      // The thread's own point: these commands are UNAMBIGUOUSLY Claude's
      // CLI deliberately continuing/resuming an existing session — unlike
      // the short-flag forms above, there is no value-boundary ambiguity to
      // hide a false positive in — but no exact id can be read. Leaving them
      // fully unclaimed (as before) meant `detect()`'s blanket
      // `preexistingSessions` exclusion discarded a genuine wall from one of
      // these passes purely because its transcript predates the spawn.
      it.each([
        ["--continue", ["claude", "--continue", "-p", "go"]],
        ["a bare --resume with no value", ["claude", "--resume", "-p", "go"]],
      ])(
        "confirms the vendor for %s without minting or reading an id, argv unchanged",
        (_label, argv) => {
          const prepared = prepareQuotaSpawn(argv, {});
          expect(prepared?.correlation).toEqual({
            vendor: "claude",
            sessionId: null,
          });
          expect(prepared?.argv).toEqual(argv);
        },
      );
    });

    it("still claims an ordinary non-conflicting short flag", () => {
      const prepared = prepareQuotaSpawn(["claude", "-p", "go"], {});
      expect(prepared?.correlation.vendor).toBe("claude");
    });

    it("declines rather than guesses when an attached VALUE contains a conflict letter", () => {
      // `-mclaude-opus-5` is `-m` plus a value; the `c` and `r` inside that
      // value are not flags. But `-pr` IS two flags, and nothing here can
      // tell the forms apart without knowing which short options take
      // values — undocumented vendor detail that drifts.
      //
      // So this pins the SAFE side of a genuine ambiguity, not an ideal
      // outcome: declining costs only exact correlation (detection falls
      // back to `preexistingSessions`), while claiming wrongly could append
      // `--session-id` to a command already resuming a session and break
      // every round.
      expect(
        prepareQuotaSpawn(["claude", "-mclaude-opus-5", "-p", "go"], {}),
      ).toBeNull();
    });

    it("mints a DIFFERENT id per call, so a later round cannot reuse an earlier session", () => {
      const a = prepareQuotaSpawn(["claude", "-p", "go"], {});
      const b = prepareQuotaSpawn(["claude", "-p", "go"], {});
      expect(a?.correlation.sessionId).not.toBe(b?.correlation.sessionId);
    });

    it("honours DRIVE_PR_QUOTA_NO_SPAWN_PREP=1 as a wholesale opt-out", () => {
      process.env.DRIVE_PR_QUOTA_NO_SPAWN_PREP = "1";
      expect(prepareQuotaSpawn(["claude", "-p", "go"], {})).toBeNull();
    });

    it("does not claim a `codex exec` command — that adapter mints nothing", () => {
      // Not an oversight: `codex exec` takes no caller-supplied session id,
      // so the Codex path relies on `preexistingSessions` alone.
      expect(codexAdapter.prepareSpawn).toBeUndefined();
      expect(prepareQuotaSpawn(["codex", "exec", "go"], {})).toBeNull();
    });

    it("passes the env through unchanged — only argv is amended", () => {
      const env = { FOO: "bar" };
      expect(prepareQuotaSpawn(["claude", "-p", "go"], env)?.env).toEqual(env);
    });
  });

  describe("correlation — a wall from another session in the same worktree", () => {
    it("reports the wall written by the session we spawned", () => {
      writeClaude("ours.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
          sessionId: "ours-1111",
        }),
      ]);
      const b = claudeAdapter.detect({
        cwd: CWD,
        since: SINCE,
        now: NOW,
        correlation: { vendor: "claude", sessionId: "ours-1111" },
      });
      expect(b?.window).toBe("short");
    });

    it("IGNORES a wall from a different session in the SAME worktree", () => {
      // The defect verbatim: without correlation this record satisfies `cwd`
      // and `since`, and becomes the wall this pass sleeps on.
      writeClaude("theirs.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
          sessionId: "someone-elses-2222",
        }),
      ]);
      const opts = { cwd: CWD, since: SINCE, now: NOW };
      // Uncorrelated, this IS attributed to our pass — the behaviour being fixed.
      expect(claudeAdapter.detect(opts)?.window).toBe("short");
      expect(
        claudeAdapter.detect({
          ...opts,
          correlation: { vendor: "claude", sessionId: "ours-1111" },
        }),
      ).toBeNull();
    });

    it("SAYS SO when it discards otherwise-valid walls purely on the session id", () => {
      // Fail closed, but never fail quiet. If `--session-id` ever stops
      // taking effect, every wall is discarded by the id clause alone and
      // the driver reports ordinary pass failures forever — the exact
      // "silently-stops-detecting" mode this file exists to remove.
      writeClaude("theirs.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
          sessionId: "someone-elses-2222",
        }),
      ]);
      const said: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => {
        said.push(args.map(String).join(" "));
      };
      try {
        expect(
          claudeAdapter.detect({
            cwd: CWD,
            since: SINCE,
            now: NOW,
            correlation: { vendor: "claude", sessionId: "ours-1111" },
          }),
        ).toBeNull();
      } finally {
        console.error = realError;
      }
      expect(said.join("\n")).toContain("discarded 1");
      expect(said.join("\n")).toContain("DRIVE_PR_QUOTA_NO_SPAWN_PREP=1");
    });

    it("stays SILENT when there was simply nothing to discard", () => {
      // The counter must not fire on a quiet account, or the signal is noise.
      const said: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => {
        said.push(args.map(String).join(" "));
      };
      try {
        expect(
          claudeAdapter.detect({
            cwd: CWD,
            since: SINCE,
            now: NOW,
            correlation: { vendor: "claude", sessionId: "ours-1111" },
          }),
        ).toBeNull();
      } finally {
        console.error = realError;
      }
      expect(said).toEqual([]);
    });

    it("fails CLOSED on a record carrying no sessionId once we have an id to match", () => {
      // Stopping on an ordinary pass failure is the safe wrong answer;
      // sleeping on evidence we cannot attribute is the unsafe one.
      writeClaude("anon.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
        }),
      ]);
      expect(
        claudeAdapter.detect({
          cwd: CWD,
          since: SINCE,
          now: NOW,
          correlation: { vendor: "claude", sessionId: "ours-1111" },
        }),
      ).toBeNull();
    });

    it("does NOT suppress an adapter the correlation does not name", () => {
      // A Claude pass routinely spawns `codex exec` underneath it, so a Codex
      // wall during a Claude pass can be the genuine cause. A correlation
      // naming one vendor must not read as "only that vendor may report".
      writeCodex("rollout-pass.jsonl", CWD, [
        {
          timestamp: "2026-08-20T12:30:00.000Z",
          rate_limits: {
            limit_id: "codex",
            primary: window(100, 300, "2026-08-20T13:30:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      ]);
      const b = detectQuotaBlock({
        cwd: CWD,
        since: SINCE,
        now: NOW,
        correlation: { vendor: "claude", sessionId: "ours-1111" },
      });
      expect(b?.vendor).toBe("codex");
    });

    it("ignores a correlation that names a DIFFERENT vendor rather than matching on it", () => {
      // A Codex session id is not a Claude session id. Reading it as one
      // would match nothing and silently suppress every Claude wall.
      writeClaude("ours.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
          sessionId: "ours-1111",
        }),
      ]);
      const b = claudeAdapter.detect({
        cwd: CWD,
        since: SINCE,
        now: NOW,
        correlation: { vendor: "codex", sessionId: "some-codex-id" },
      });
      expect(b?.window).toBe("short");
    });
  });

  describe("preexistingSessions — a session that started before the pass", () => {
    it("claude: ignores a wall in a transcript that already existed at spawn", () => {
      writeClaude("chat.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
          sessionId: "human-chat",
        }),
      ]);
      const preexistingSessions = new Set(
        claudeAdapter.snapshotSessions().files,
      );
      expect(preexistingSessions.size).toBe(1);
      expect(
        claudeAdapter.detect({
          cwd: CWD,
          since: SINCE,
          now: NOW,
          preexistingSessions,
        }),
      ).toBeNull();
    });

    it("claude: reports a wall in a transcript created AFTER the snapshot", () => {
      const preexistingSessions = new Set(
        claudeAdapter.snapshotSessions().files,
      );
      writeClaude("pass.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
          sessionId: "pass-session",
        }),
      ]);
      expect(
        claudeAdapter.detect({
          cwd: CWD,
          since: SINCE,
          now: NOW,
          preexistingSessions,
        })?.window,
      ).toBe("short");
    });

    it("claude: a --resume pass IS detected even though its transcript predates the spawn", () => {
      // The concrete gap this closes: `--resume <id>` appends to a transcript
      // that legitimately existed BEFORE the spawn, so it is captured by
      // `preexistingSessions` like any other pre-existing file. Once
      // `prepareSpawn` correlates on the resumed id, the wall it appends during
      // THIS pass must still be detected — the blanket file-level exclusion
      // must not win over an exact session-id match.
      const older = claudeWall({
        cwd: CWD,
        timestamp: "2026-08-19T09:00:00.000Z",
        text: SHORT_WALL,
        sessionId: "resumed-session",
      });
      writeClaude("resumed.jsonl", [older]);
      const preexistingSessions = new Set(
        claudeAdapter.snapshotSessions().files,
      );
      expect(preexistingSessions.size).toBe(1);
      // The resumed pass appends a NEW turn to the SAME file, after `since`.
      const newer = claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: SHORT_WALL,
        sessionId: "resumed-session",
      });
      writeClaude("resumed.jsonl", [older, newer]);
      expect(
        claudeAdapter.detect({
          cwd: CWD,
          since: SINCE,
          now: NOW,
          preexistingSessions,
          correlation: { vendor: "claude", sessionId: "resumed-session" },
        })?.window,
      ).toBe("short");
    });

    it("claude: a --continue/bare-resume pass (no exact id) stays excluded even though its transcript predates the spawn", () => {
      // `--continue`/`-c` and a bare/ambiguous `--resume` are deliberately left
      // unclaimed by `prepareSpawn` (no exact id to mint or read), but
      // `prepareQuotaSpawn` still confirms the vendor and hands `detect()` a
      // `sessionId: null` correlation. An earlier version let that `null`
      // correlation bypass the blanket `preexistingSessions` exclusion on its
      // own, which reopened a gap (see the two-candidate test below) and was
      // reverted. Without an exact id there is no per-record match to fall back
      // on either, so a preexisting file must stay excluded regardless of
      // `since` — a genuine wall from this pass is a missed detection, not a
      // misattribution risk.
      const older = claudeWall({
        cwd: CWD,
        timestamp: "2026-08-19T09:00:00.000Z",
        text: SHORT_WALL,
        sessionId: "continued-session",
      });
      writeClaude("continued.jsonl", [older]);
      const preexistingSessions = new Set(
        claudeAdapter.snapshotSessions().files,
      );
      expect(preexistingSessions.size).toBe(1);
      const newer = claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: SHORT_WALL,
        sessionId: "continued-session",
      });
      writeClaude("continued.jsonl", [older, newer]);
      expect(
        claudeAdapter.detect({
          cwd: CWD,
          since: SINCE,
          now: NOW,
          preexistingSessions,
          correlation: { vendor: "claude", sessionId: null },
        }),
      ).toBeNull();
    });

    it("claude: a --continue/bare-resume pass does NOT pick up an unrelated pre-existing session's wall", () => {
      // The regression this closes: with
      // TWO pre-existing session files in the worktree, a no-id `--continue`
      // correlation cannot tell which one this pass actually resumed. Round
      // 4's fix bypassed the file-level exclusion for the WHOLE
      // `vendorConfirmed` set, so a human's own concurrent session — a
      // completely different file — could append a wall after `since` and
      // have it misattributed to this pass, parking or sleeping the drive on
      // someone else's evidence. Only the file this pass actually continued
      // ('continued-session') is genuinely its own; 'unrelated-human-chat' is
      // a different session in the same worktree that happens to hit a wall
      // in the same window. Neither may surface without an exact id.
      writeClaude("continued.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-19T09:00:00.000Z",
          text: SHORT_WALL,
          sessionId: "continued-session",
        }),
      ]);
      writeClaude("unrelated.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-19T09:05:00.000Z",
          text: SHORT_WALL,
          sessionId: "unrelated-human-chat",
        }),
      ]);
      const preexistingSessions = new Set(
        claudeAdapter.snapshotSessions().files,
      );
      expect(preexistingSessions.size).toBe(2);
      // The unrelated human session appends its OWN wall after `since` —
      // this is the record that must not surface.
      writeClaude("unrelated.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-19T09:05:00.000Z",
          text: SHORT_WALL,
          sessionId: "unrelated-human-chat",
        }),
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
          sessionId: "unrelated-human-chat",
        }),
      ]);
      expect(
        claudeAdapter.detect({
          cwd: CWD,
          since: SINCE,
          now: NOW,
          preexistingSessions,
          correlation: { vendor: "claude", sessionId: null },
        }),
      ).toBeNull();
    });

    it("claude: a --continue/bare-resume correlation stays excluded even when a truncated snapshot cannot verify it", () => {
      // Same corrected behaviour as the plain no-id case above, asserted
      // with `preexistingSessionsTruncated: true` too: a truncated snapshot
      // must not change the answer, since the file-level exclusion for a
      // no-id correlation no longer depends on snapshot completeness at all.
      const older = claudeWall({
        cwd: CWD,
        timestamp: "2026-08-19T09:00:00.000Z",
        text: SHORT_WALL,
        sessionId: "continued-session",
      });
      writeClaude("continued.jsonl", [older]);
      const preexistingSessions = new Set(
        claudeAdapter.snapshotSessions().files,
      );
      const newer = claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: SHORT_WALL,
        sessionId: "continued-session",
      });
      writeClaude("continued.jsonl", [older, newer]);
      expect(
        claudeAdapter.detect({
          cwd: CWD,
          since: SINCE,
          now: NOW,
          preexistingSessions,
          preexistingSessionsTruncated: true,
          correlation: { vendor: "claude", sessionId: null },
        }),
      ).toBeNull();
    });

    it("claude: WITHOUT correlation, a pre-existing transcript stays excluded even when appended to", () => {
      // The ordinary (non-resume) case must not regress: absent an exact id
      // to check records against, file-level exclusion remains the only
      // defense against a concurrent human session in the same worktree.
      const older = claudeWall({
        cwd: CWD,
        timestamp: "2026-08-19T09:00:00.000Z",
        text: SHORT_WALL,
        sessionId: "human-chat",
      });
      writeClaude("theirs.jsonl", [older]);
      const preexistingSessions = new Set(
        claudeAdapter.snapshotSessions().files,
      );
      const newer = claudeWall({
        cwd: CWD,
        timestamp: "2026-08-20T12:30:00.000Z",
        text: SHORT_WALL,
        sessionId: "human-chat",
      });
      writeClaude("theirs.jsonl", [older, newer]);
      expect(
        claudeAdapter.detect({
          cwd: CWD,
          since: SINCE,
          now: NOW,
          preexistingSessions,
        }),
      ).toBeNull();
    });

    it("codex: ignores a wall in a rollout that already existed at spawn", () => {
      writeCodex("rollout-chat.jsonl", CWD, [
        {
          timestamp: "2026-08-20T12:30:00.000Z",
          rate_limits: {
            limit_id: "codex",
            primary: window(100, 10080, "2026-08-27T12:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      ]);
      const preexistingSessions = new Set(
        codexAdapter.snapshotSessions().files,
      );
      expect(
        codexAdapter.detect({
          cwd: CWD,
          since: SINCE,
          now: NOW,
          preexistingSessions,
        }),
      ).toBeNull();
    });

    it("codex: another session's newer HEALTHY event cannot clear this pass's real wall", () => {
      // The second half of the reported defect, and the one a cwd filter can
      // never reach: a concurrent session's recovery telemetry is NEWER than
      // our wall, so the newest-record-wins rule clears a block that is still
      // very much in force for the pass that actually failed.
      writeCodex("rollout-chat.jsonl", CWD, [
        {
          timestamp: "2026-08-20T12:50:00.000Z",
          rate_limits: {
            limit_id: "codex",
            primary: window(3, 300, "2026-08-20T17:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      ]);
      const preexistingSessions = new Set(
        codexAdapter.snapshotSessions().files,
      );
      writeCodex("rollout-pass.jsonl", CWD, [
        {
          timestamp: "2026-08-20T12:30:00.000Z",
          rate_limits: {
            limit_id: "codex",
            primary: window(100, 300, "2026-08-20T13:30:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      ]);
      const opts = { cwd: CWD, since: SINCE, now: NOW };
      // Without the snapshot the healthy 12:50 record wins and clears it.
      expect(codexAdapter.detect(opts)).toBeNull();
      expect(
        codexAdapter.detect({ ...opts, preexistingSessions })?.window,
      ).toBe("short");
    });
  });

  describe("snapshotQuotaSessions", () => {
    it("unions both vendors, and returns a dormant file the mtime filter would drop", () => {
      writeClaude("old.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2020-01-01T00:00:00.000Z",
          text: SHORT_WALL,
        }),
      ]);
      writeCodex("rollout-old.jsonl", CWD, []);
      // The fixtures must be genuinely DORMANT, not merely named so. Written
      // milliseconds before the snapshot, their mtime is ~now, and a recency
      // floor anywhere at or below `now` is then invisible to this test —
      // which made it pass or fail by sub-millisecond accident against the
      // one mutation it exists to catch (`candidateFiles(0)` →
      // `candidateFiles(Date.now())`, measured at 0/1/0 failures over three
      // runs). Backdating makes the floor the sole decider, so the same
      // mutation reddens every time. That mutation is not academic: it is
      // an earlier change reopened — a chat transcript last written shortly before
      // the spawn drops out of the snapshot, the human sends one more
      // message during the pass, and its wall is then attributed to us.
      const dormant = new Date("2020-01-01T00:00:00.000Z");
      const claudeOld = join(
        root,
        "claude",
        "-Users-dev-workspaces-proj-alpha",
        "old.jsonl",
      );
      const codexOld = join(
        root,
        "codex",
        "2026",
        "08",
        "20",
        "rollout-old.jsonl",
      );
      utimesSync(claudeOld, dormant, dormant);
      utimesSync(codexOld, dormant, dormant);

      const snapshot = snapshotQuotaSessions();
      expect(snapshot.files.size).toBe(2);
      expect(snapshot.truncatedByVendor.get("claude")).toBe(false);
      expect(snapshot.truncatedByVendor.get("codex")).toBe(false);
      // The snapshot's question is "what already exists", never "what changed
      // recently": a transcript untouched for years is still one this pass
      // did not create, and it can be appended to a second from now.
      expect(snapshot.files.has(claudeOld)).toBe(true);
      expect(snapshot.files.has(codexOld)).toBe(true);
    });

    it("returns an empty, untruncated set, and does not throw, when neither vendor has state", () => {
      // The ordinary case for a machine with only one of the two installed —
      // and this runs immediately before spawning a pass, where a throw would
      // abort a round that had nothing wrong with it.
      process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR = join(root, "absent-claude");
      process.env.DRIVE_PR_CODEX_SESSIONS_DIR = join(root, "absent-codex");
      const snapshot = snapshotQuotaSessions();
      expect(snapshot.files.size).toBe(0);
      expect(snapshot.truncatedByVendor.get("claude")).toBe(false);
      expect(snapshot.truncatedByVendor.get("codex")).toBe(false);
    });

    it("stops the walk before it finds real files once the wall-clock deadline is exhausted, and reports truncated", () => {
      // Deterministic, not merely likely: `deadlineAt = Date.now() +
      // maxCandidateScanMs()`, so a zero budget makes `deadlineAt` equal to
      // the instant it was computed — and time only moves forward, so the
      // very first `now >= deadlineAt` check inside the walk is guaranteed
      // true. This is the integration counterpart to the `scanBudgetExceeded`
      // unit tests above: it proves the constant is actually wired into
      // `candidateFiles()`, not just correct in isolation. `truncated: true`
      // is the signal `detect()` needs to tell "this file doesn't exist" apart
      // from "the walk never got far enough to find out" — see the discard
      // tests below.
      writeClaude("s.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
        }),
      ]);
      writeCodex("rollout.jsonl", CWD, []);
      process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "0";
      const snapshot = snapshotQuotaSessions();
      expect(snapshot.files.size).toBe(0);
      expect(snapshot.truncatedByVendor.get("claude")).toBe(true);
      expect(snapshot.truncatedByVendor.get("codex")).toBe(true);
    });

    it("marks only the vendor whose OWN walk truncated, not the other one — the aggregate-flag defect", () => {
      // Claude has real state to walk (and truncates on it); Codex has none
      // at all, so its walk finishes trivially. A flat OR across vendors used
      // to report BOTH as truncated whenever EITHER one was, which then made
      // `detectQuotaBlock` discard Codex's fully-reliable candidates for a
      // reason that belonged to Claude alone.
      writeClaude("s.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
        }),
      ]);
      process.env.DRIVE_PR_CODEX_SESSIONS_DIR = join(root, "absent-codex");
      process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "0";
      const snapshot = snapshotQuotaSessions();
      expect(snapshot.truncatedByVendor.get("claude")).toBe(true);
      expect(snapshot.truncatedByVendor.get("codex")).toBe(false);
    });

    it("marks a vendor UNRELIABLE, not falsely clean, when its adapter throws during the snapshot walk", () => {
      // A throw contributes nothing verifiable — the same "unreliable" case a
      // truncated walk signals, not a complete empty scan. The old catch
      // swallowed the throw and left `truncated` unset for that vendor, which
      // read as a clean, complete scan everywhere it was consulted — trusting
      // `preexistingSessions`' absence as proof of newness exactly like a
      // genuinely finished walk would.
      writeCodex("rollout.jsonl", CWD, []);
      const original = claudeAdapter.snapshotSessions;
      claudeAdapter.snapshotSessions = () => {
        throw new Error("boom");
      };
      try {
        const snapshot = snapshotQuotaSessions();
        expect(snapshot.truncatedByVendor.get("claude")).toBe(true);
        expect(snapshot.truncatedByVendor.get("codex")).toBe(false);
      } finally {
        claudeAdapter.snapshotSessions = original;
      }
    });

    it("marks a vendor unreliable when its root exists but cannot be enumerated, rather than silently reading it as empty", () => {
      // Before this fix, `forEachDirEntry` treated an `opendirSync` failure
      // (here: the configured root is a plain FILE, so opening it as a
      // directory throws ENOTDIR) identically to a directory that simply
      // does not exist — silently visiting nothing and reporting a clean,
      // untruncated scan. A pre-existing session this walk could not even
      // attempt to enumerate would then be misattributed to a later pass
      // exactly like a genuinely complete empty snapshot would.
      writeFileSync(process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR as string, "");
      writeCodex("rollout.jsonl", CWD, []);
      const snapshot = snapshotQuotaSessions();
      // Only the codex fixture is real — Claude's walk never got past its
      // own (file-shaped) root, so it contributes nothing.
      expect(snapshot.files.size).toBe(1);
      expect(snapshot.truncatedByVendor.get("claude")).toBe(true);
      expect(snapshot.truncatedByVendor.get("codex")).toBe(false);
    });
  });

  describe("preexistingSessionsTruncated — a snapshot that did not finish enumerating the tree", () => {
    // The defect this class of test pins:
    // the entry-count cap enumerates the SAME set on every call given a
    // stable directory order, but the wall-clock cap does not — real elapsed
    // time can differ between the pre-spawn snapshot and a later `detect()`
    // call over the identical tree, EVEN BELOW `MAX_CANDIDATE_FILES_SCANNED`.
    // So a pre-existing session the snapshot's walk did not reach must not be
    // silently treated as "new" just because it is absent from
    // `preexistingSessions` — these fixtures simulate exactly that gap by
    // constructing an INCOMPLETE snapshot directly (a `Set` missing a file
    // that genuinely predates the pass) and asserting the discard fires.
    it("codex: discards a candidate rather than misattributing it when the snapshot is truncated", () => {
      writeCodex("rollout-chat.jsonl", CWD, [
        {
          timestamp: "2026-08-20T12:30:00.000Z",
          rate_limits: {
            limit_id: "codex",
            primary: window(100, 10080, "2026-08-27T12:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      ]);
      // Deliberately EMPTY: simulates the snapshot's own walk missing this
      // pre-existing file entirely, the way a wall-clock timeout can.
      const preexistingSessions = new Set<string>();
      const opts = { cwd: CWD, since: SINCE, now: NOW, preexistingSessions };
      // Sanity: without the truncated flag, this incomplete snapshot DOES
      // misattribute the pre-existing wall — proving the fixture actually
      // exercises the gap the flag exists to close, not a vacuous scenario.
      expect(codexAdapter.detect(opts)?.window).toBe("weekly");
      expect(
        codexAdapter.detect({ ...opts, preexistingSessionsTruncated: true }),
      ).toBeNull();
    });

    it("claude: discards a candidate rather than misattributing it when the snapshot is truncated and no session correlation exists", () => {
      writeClaude("chat.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
          sessionId: "human-chat",
        }),
      ]);
      const preexistingSessions = new Set<string>();
      const opts = { cwd: CWD, since: SINCE, now: NOW, preexistingSessions };
      expect(claudeAdapter.detect(opts)?.window).toBe("short");
      expect(
        claudeAdapter.detect({ ...opts, preexistingSessionsTruncated: true }),
      ).toBeNull();
    });

    it("claude: a truncated snapshot does not suppress a wall confirmed by exact session-id correlation", () => {
      // The residual this flag closes is specifically the case with NO
      // independent way to verify a candidate. When `prepareSpawn` minted a
      // session id and the record carries it, that match is conclusive on
      // its own — a truncated snapshot must not additionally suppress it.
      writeClaude("pass.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
          sessionId: "pass-session",
        }),
      ]);
      const preexistingSessions = new Set<string>();
      expect(
        claudeAdapter.detect({
          cwd: CWD,
          since: SINCE,
          now: NOW,
          preexistingSessions,
          preexistingSessionsTruncated: true,
          correlation: { vendor: "claude", sessionId: "pass-session" },
        })?.window,
      ).toBe("short");
    });
  });

  describe("the detection-time scan (candidateFiles) truncating, independent of the pre-spawn snapshot", () => {
    // The defect this class pins: this
    // scan runs a SECOND TIME, at detection, over files touched since the
    // pass started — a separate walk from `snapshotSessions()` above, so it
    // can truncate on its own even when the pre-spawn snapshot finished
    // cleanly. Discarding its own `.truncated` silently made "no wall found"
    // indistinguishable from "the walk never reached the file that had one".
    it("codex: SAYS SO when the detection scan truncates and finds nothing", () => {
      writeCodex("r.jsonl", CWD, [
        {
          timestamp: "2026-08-20T12:30:00.000Z",
          rate_limits: {
            limit_id: "codex",
            primary: window(100, 10080, "2026-08-27T12:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      ]);
      process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "0";
      const said: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => {
        said.push(args.map(String).join(" "));
      };
      try {
        expect(
          codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
        ).toBeNull();
      } finally {
        console.error = realError;
      }
      expect(said.join("\n")).toContain("detection scan");
      expect(said.join("\n")).toContain("truncated");
    });

    it("claude: SAYS SO when the detection scan truncates and finds nothing", () => {
      writeClaude("s.jsonl", [
        claudeWall({
          cwd: CWD,
          timestamp: "2026-08-20T12:30:00.000Z",
          text: SHORT_WALL,
        }),
      ]);
      process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS = "0";
      const said: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => {
        said.push(args.map(String).join(" "));
      };
      try {
        expect(
          claudeAdapter.detect({ cwd: CWD, since: SINCE, now: NOW }),
        ).toBeNull();
      } finally {
        console.error = realError;
      }
      expect(said.join("\n")).toContain("detection scan");
      expect(said.join("\n")).toContain("truncated");
    });

    it("stays SILENT when a wall was actually found despite the scan truncating", () => {
      // The diagnostic exists to explain an otherwise-unexplained "no wall
      // found"; it must not fire when a block WAS found (`best !== null`).
      writeCodex("r.jsonl", CWD, [
        {
          timestamp: "2026-08-20T12:30:00.000Z",
          rate_limits: {
            limit_id: "codex",
            primary: window(100, 10080, "2026-08-27T12:00:00.000Z"),
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      ]);
      const said: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => {
        said.push(args.map(String).join(" "));
      };
      try {
        expect(
          codexAdapter.detect({ cwd: CWD, since: SINCE, now: NOW })?.window,
        ).toBe("weekly");
      } finally {
        console.error = realError;
      }
      expect(said).toEqual([]);
    });
  });
});
