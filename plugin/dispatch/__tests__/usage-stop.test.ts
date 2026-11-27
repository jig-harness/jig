/**
 * A Claude Code session the wrapper started that stops on the vendor's
 * usage-limit notice, as its transcript's last assistant entry, walls its
 * account until the notice's reset, however long the pass ran and whether or
 * not the session left a transcript; nothing else of the transcript is kept.
 */
import { afterEach, describe, expect, it, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import { readRecord } from "../lib/launches.ts";
import { failedStartup, startupWall } from "../lib/session-startup.ts";
import { stateDb } from "../lib/state.ts";
import { readTranscriptCopy } from "../lib/transcript-copy.ts";
import { wallOf } from "../lib/walls.ts";
import { isoFromMs } from "../../shared/time.ts";
import {
  assignedIssue,
  mergedPr,
  SLUG,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";
const SENTINEL = "private working note";

/** The dated notice Claude Code writes for a weekly limit that resets at `ms`, in UTC. */
function weeklyNotice(ms: number): string {
  const t =
    Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO("UTC");
  const month = t.toLocaleString("en-US", { month: "short" });
  const hour = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `You've hit your weekly limit · resets ${month} ${t.day}, ${hour}${t.hour < 12 ? "am" : "pm"} (UTC)`;
}

/** Two days out, on the hour, as the weekly notice states it. */
function weeklyReset(): number {
  return (
    Math.floor((Date.now() + 2 * 24 * 60 * 60_000) / 3_600_000) * 3_600_000
  );
}

const userEntry = (content: unknown) => ({
  type: "user",
  message: { role: "user", content },
});
const assistantText = (text: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
/** The entry Claude Code appends when the vendor refuses a turn at the usage limit. */
const limitEntry = (text: string) => ({
  type: "assistant",
  message: {
    role: "assistant",
    model: "<synthetic>",
    content: [{ type: "text", text }],
  },
  error: "rate_limit",
  isApiErrorMessage: true,
});

function writeTranscript(
  configDir: string,
  session: string,
  entries: unknown[],
): void {
  const project = join(configDir, "projects", "repo");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, `${session}.jsonl`),
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
}

/** A transcript of a pass that worked, then met the limit. */
const stoppedAtLimit = (notice: string) => [
  userEntry("Pick up the item."),
  assistantText(`Reading the item first. ${SENTINEL}`),
  userEntry([
    { type: "tool_result", tool_use_id: "t1", content: "file contents" },
  ]),
  limitEntry(notice),
];

describe("which ended sessions stopped on a usage notice", () => {
  const root = join(process.cwd(), ".context", `usage-stop-${process.pid}`);
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const recordOf = (fields: Record<string, unknown> = {}) => {
    const configDir = join(root, "config");
    mkdirSync(join(configDir, "projects"), { recursive: true });
    return {
      vendor: "claude",
      account: "a",
      sessionId: SESSION,
      configDir,
      wallBackoffMs: 30 * 60_000,
      action: "followup",
      ...fields,
    } as unknown as Parameters<typeof failedStartup>[0];
  };
  const notice = "You've hit your weekly limit · resets Nov 22, 10am (UTC)";
  const started = Date.now() - 600_000;
  const quick = started + 5_000;
  const late = started + 300_000;

  it.each([
    { action: "pickup", headless: true },
    { action: "steward" },
    { action: "followup" },
  ])(
    "classes a %o session whose last assistant entry is the notice as quota, early or late",
    (fields) => {
      const record = recordOf(fields);
      writeTranscript(record.configDir, SESSION, stoppedAtLimit(notice));
      expect(failedStartup(record, 1, started, "", quick)).toBe("quota");
      expect(failedStartup(record, 1, started, "", late)).toBe("quota");
    },
  );

  it("classes a late pass whose own output is the notice as quota when no transcript exists", () => {
    const record = recordOf();
    expect(failedStartup(record, 1, started, `${notice}\n`, late)).toBe(
      "quota",
    );
    expect(failedStartup(record, 1, started, `${notice}\n`, quick)).toBe(
      "quota",
    );
  });

  it("does not let output text override a readable transcript that rejected the notice", () => {
    const record = recordOf();
    writeTranscript(record.configDir, SESSION, [assistantText("working")]);
    expect(
      failedStartup(record, 1, started, `${notice}\n`, late),
    ).toBeUndefined();
  });

  it.each([
    ["no notice", [userEntry("go"), assistantText("Done working.")]],
    ["the notice only in a user entry", [userEntry(notice)]],
    [
      "the notice only in a tool's output",
      [
        assistantText("Running the check."),
        userEntry([
          { type: "tool_result", tool_use_id: "t1", content: notice },
        ]),
      ],
    ],
    [
      "the notice only in a tool call",
      [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "Bash",
                input: { command: `echo "${notice}"` },
              },
            ],
          },
        },
      ],
    ],
    [
      "the notice inside a longer assistant message",
      [assistantText(`The vendor says:\n${notice}\nso I stop.`)],
    ],
    [
      "the notice as ordinary assistant text with no vendor error",
      [assistantText(notice)],
    ],
    [
      "a rate_limit error that lacks the vendor's error-message marker",
      [{ ...limitEntry(notice), isApiErrorMessage: undefined }],
    ],
    [
      "the notice in an earlier assistant entry",
      [limitEntry(notice), userEntry("go on"), assistantText("Carrying on.")],
    ],
  ])("reads a transcript with %s as before", (_name, entries) => {
    const record = recordOf();
    writeTranscript(record.configDir, SESSION, entries);
    expect(failedStartup(record, 1, started, "", quick)).toBeUndefined();
    expect(failedStartup(record, 1, started, "", late)).toBeUndefined();
  });

  it("reads the last assistant entry past a user entry that follows it", () => {
    const record = recordOf();
    writeTranscript(record.configDir, SESSION, [
      limitEntry(notice),
      userEntry("queued message"),
    ]);
    expect(failedStartup(record, 1, started, "", late)).toBe("quota");
  });

  it("classes a notice in the output of a pass with no session id as quota", () => {
    const record = recordOf({ sessionId: null });
    expect(failedStartup(record, 1, started, `${notice}\n`, late)).toBe(
      "quota",
    );
  });

  it("prefers the transcript's quota error over an earlier sign-in line", () => {
    const record = recordOf();
    writeTranscript(record.configDir, SESSION, [
      assistantText("Please run /login"),
      limitEntry(notice),
    ]);
    expect(failedStartup(record, 1, started, "", quick)).toBe("quota");
  });

  it.each([{ action: "pickup" }, { action: "rearm" }])(
    "leaves a %o session to the stage that runs it",
    (fields) => {
      const record = recordOf(fields);
      writeTranscript(record.configDir, SESSION, stoppedAtLimit(notice));
      expect(failedStartup(record, 1, started, "", late)).toBeUndefined();
    },
  );

  it("does not read a pass that exited cleanly", () => {
    const record = recordOf();
    writeTranscript(record.configDir, SESSION, stoppedAtLimit(notice));
    expect(failedStartup(record, 0, started, "", late)).toBeUndefined();
  });

  it("walls until the notice's reset, else for wall_backoff, saying which", () => {
    const nowMs = Temporal.Instant.from(
      "2026-11-20T09:00:00Z",
    ).epochMilliseconds;
    const record = recordOf();
    writeTranscript(record.configDir, SESSION, stoppedAtLimit(notice));
    const read = startupWall(record, "quota", "", nowMs);
    expect(read.resetAt).toBe("2026-11-22T10:00:00.000Z");
    expect(read.source).toContain("the usage notice's reset");
    writeTranscript(
      record.configDir,
      SESSION,
      stoppedAtLimit("You've hit your weekly limit · resets whenever"),
    );
    const unread = startupWall(record, "quota", "", nowMs);
    expect(unread.resetAt).toBe(isoFromMs(nowMs + 30 * 60_000));
    expect(unread.source).toContain("the notice's reset did not read");
    expect(unread.source).not.toContain("whenever");
    expect(unread.source).toContain("wall_backoff");
    expect(startupWall(record, "unstarted", "", nowMs).source).toBe(
      "session could not start (unstarted); wall_backoff",
    );
  });
});

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

function endRow(w: World, id: string) {
  return stateDb(dispatchState(w))
    .query(
      `SELECT bucket AS class, reason, row FROM log
     WHERE kind = 'ended' AND json_extract(row, '$.record') = ?`,
    )
    .get(id) as { class: string; reason: string; row: string } | null;
}

async function needs(w: World) {
  const result = await w.dispatch(["line", "--json"]);
  expectSpawnExit(result, 0);
  return (JSON.parse(result.stdout) as { value: { line: LineSnapshot } }).value
    .line.needs;
}

test("a usage notice in a pickup's, a follow-up's and a steward's transcript walls the account until its reset", async () => {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  identity: factory-bot\n  followup_command: /followup\n`,
  );
  withOrigin(w);
  w.setIssues([assignedIssue(12, "factory-bot", [])]);
  w.setAssigner(12, "maintainer", "WRITE");
  w.setPrs("merged", [mergedPr(9, "feature/done", "2026-10-31T12:00:00Z")]);
  w.setComments(9, []);
  const ws = join(w.root, "ws-9");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: "feature/done", linkedPR: 9, path: ws }]);
  const a = { ...account(w, "a", "a@example.com"), max: 5 };
  const b = { ...account(w, "b", "b@example.com"), max: 5 };
  const stages = ["pickup", "followup", "steward"] as const;
  const settings = { steward: { enabled: true } };
  const repo = { followup_since: "2026-10-30T00:00:00Z" };
  machineFile(w, [a], settings, [...stages], repo);
  const first = (await applyTick(w, false)).repos[0]?.launches ?? [];
  const launched = first.filter((row) => row.outcome === "launched");
  expect(launched.map(({ action }) => action).sort()).toEqual(
    [...stages].sort(),
  );
  await waitFor("the passes", () => claudeRuns(w).length === 3);
  const resetMs = weeklyReset();
  const ids = launched.map(({ record }) => String(record));
  for (const id of ids) {
    const record = readRecord(id, dispatchState(w));
    if (record?.sessionId == null) throw new Error(`no session for ${id}`);
    writeTranscript(
      record.configDir,
      record.sessionId,
      stoppedAtLimit(weeklyNotice(resetMs)),
    );
  }
  writeFileSync(join(w.dir, "claude-exit"), "1");
  await waitFor("the exits", () => ids.every((id) => exitWritten(w, id)));
  rmSync(join(w.dir, "claude-exit"));
  const wall = wallOf("a", Date.now(), dispatchState(w));
  expect(wall?.resetAt).toBe(isoFromMs(resetMs));
  expect(wall?.source).toContain("the usage notice's reset");
  for (const id of ids) {
    const row = stateDb(dispatchState(w))
      .query("SELECT exit, report FROM launches WHERE id = ?")
      .get(id) as { exit: string; report: string };
    expect(JSON.parse(row.exit)).toMatchObject({ startup: "quota" });
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
  }
  // With only the walled account, the tick starts nothing until the reset.
  const walled = (await applyTick(w, false)).repos[0]?.launches ?? [];
  expect(walled.filter((l) => l.outcome === "launched")).toEqual([]);
  for (const [index, id] of ids.entries()) {
    const row = endRow(w, id);
    // A steward that submitted nothing is logged by how its session ended.
    if (launched[index]?.action !== "steward")
      expect(row?.class).toBe("quota wall");
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
    expect(readTranscriptCopy(id, dispatchState(w))).toBeNull();
  }
  expect((await needs(w)).filter((n) => n.cause === "pickup-ended")).toEqual(
    [],
  );
  // Another free account takes every stage on.
  machineFile(w, [a, b], settings, [...stages], repo);
  const again =
    (await applyTick(w, false)).repos[0]?.launches.filter(
      (l) => l.outcome === "launched",
    ) ?? [];
  expect(again.map(({ action }) => action).sort()).toEqual([...stages].sort());
  expect(again.every(({ account }) => account === "b")).toBe(true);
}, 60_000);
