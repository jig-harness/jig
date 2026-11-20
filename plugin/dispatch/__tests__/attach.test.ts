import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkClosingReport } from "../../shared/closing-report.ts";
import type { ProcessIdentity } from "../../shared/liveness.ts";
import { ok } from "../../shared/outcome.ts";
import { attachMain, type AttachDeps, headerLines } from "../attach.ts";
import { spoolCursor } from "../lib/attach-follow.ts";
import { resumeLine } from "../lib/attach-resume.ts";
import { takeOverMark, targetAddress } from "../lib/attach-take-over.ts";
import { readKeptReport } from "../lib/closing-report-store.ts";
import {
  type InspectedRow,
  type LaunchClaim,
  type LaunchRecord,
  type LaunchState,
  recordExit,
  writeRecord,
} from "../lib/launches.ts";
import {
  personPickupBlock,
  setPersonPickupHold,
} from "../lib/person-pickup-holds.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import { takeTickLock } from "../receipts.ts";

const ID = "20260101T000000Z-aaaaaaaa";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true });
  }
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-dispatch-attach-"));
  dirs.push(dir);
  return dir;
}

function record(over: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: 1,
    id: ID,
    token: "t",
    runtime: "process",
    action: "rearm",
    repo: "o/a",
    repoPath: "/r",
    pr: 7,
    account: "acct",
    vendor: "claude",
    configDir: "/c",
    wallBackoffMs: 1,
    replaces: null,
    facts: "f",
    createdAt: "2026-01-01T00:00:00.000Z",
    workspace: { id: "w", path: "/w" },
    attempts: [],
    item: null,
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
    sessionId: "minted-session",
    ...over,
  };
}

const CLAIM: LaunchClaim = {
  hostId: "h",
  host: "h",
  bootId: "b",
  pid: 4242,
  start: "s",
  claimedAt: "2026-01-01T00:00:10.000Z",
};

/** A fake run: its state and liveness, which the suite moves on. */
interface Run {
  state: LaunchState;
  alive: boolean;
  events: string[];
  out: string[];
  err: string[];
  written: string[];
}

function fakeRun(): Run {
  return {
    state: { kind: "alive", process: CLAIM },
    alive: true,
    events: [],
    out: [],
    err: [],
    written: [],
  };
}

function exitColumn(dir: string): string | null {
  return (
    stateDb(dir).query("SELECT exit FROM launches WHERE id = ?").get(ID) as {
      exit: string | null;
    }
  ).exit;
}

function reportBy(dir: string): string | undefined {
  const row = stateDb(dir)
    .query("SELECT report FROM launches WHERE id = ?")
    .get(ID) as { report: string | null };
  return readKeptReport(row.report)?.by;
}

function deps(
  dir: string,
  run: Run,
  over: Partial<AttachDeps> = {},
): AttachDeps {
  const rec = (): LaunchRecord => {
    const row = stateDb(dir)
      .query("SELECT record FROM launches WHERE id = ?")
      .get(ID) as { record: string } | null;
    return JSON.parse(row?.record ?? "null") as LaunchRecord;
  };
  return {
    root: dir,
    inspect: async (id) => {
      if (id !== ID) return null;
      const exit = exitColumn(dir);
      const state: LaunchState =
        exit !== null && run.state.kind !== "ended"
          ? {
              kind: "ended",
              exit: JSON.parse(exit) as never,
              process: CLAIM,
            }
          : run.state;
      return { record: rec(), state, claim: null, exit } as InspectedRow;
    },
    members: async () => ({
      alive: run.alive ? [CLAIM.pid] : [],
      uncertain: false,
      identities: run.alive ? [CLAIM as ProcessIdentity] : [],
    }),
    hold: async (address) => {
      run.events.push(`hold ${address} exit=${exitColumn(dir) ?? "none"}`);
      return ok("held" as const);
    },
    stops: [
      async () => {
        run.events.push("stop drive");
        return "drive told to stop";
      },
      async () => {
        run.events.push("stop service");
        run.alive = false;
        return "unit stopped";
      },
    ],
    signal: async (_m, signal) => {
      run.events.push(signal);
      return "signalled";
    },
    sleep: async () => undefined,
    out: (line) => run.out.push(line),
    err: (line) => run.err.push(line),
    write: (chunk) => run.written.push(String(chunk)),
    signalAbort: new AbortController().signal,
    intervalMs: 1,
    graceMs: 0,
    lockWaitMs: 0,
    ...over,
  };
}

describe("jig dispatch attach: refusals", () => {
  it("refuses an id that is not a launch record id", async () => {
    const dir = root();
    const run = fakeRun();
    expect(await attachMain("nope", { takeOver: false }, deps(dir, run))).toBe(
      2,
    );
  });

  it("refuses an unknown record", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const run = fakeRun();
    const code = await attachMain(
      "20260101T000000Z-bbbbbbbb",
      { takeOver: false },
      deps(dir, run),
    );
    expect(code).toBe(2);
    expect(run.err.join("\n")).toContain("no launch record");
  });

  it("refuses a record that is not on the process runtime", async () => {
    const dir = root();
    const { runtime: _, ...orca } = record();
    writeRecord(orca, dir);
    const run = fakeRun();
    expect(await attachMain(ID, { takeOver: true }, deps(dir, run))).toBe(2);
    expect(run.err.join("\n")).toContain("tab already shows the run");
    expect(run.events).toEqual([]);
  });

  it("refuses to take over a steward run, which has no target to hold", async () => {
    const dir = root();
    writeRecord(record({ action: "steward", pr: null }), dir);
    const run = fakeRun();
    expect(await attachMain(ID, { takeOver: true }, deps(dir, run))).toBe(2);
    expect(run.events).toEqual([]);
  });
});

describe("jig dispatch attach: watching", () => {
  it("prints the run's worktree, account, stage and time running", () => {
    const lines = headerLines(
      { record: record(), state: { kind: "alive", process: CLAIM } } as never,
      Date.parse("2026-01-01T01:02:13.000Z"),
    );
    expect(lines).toEqual([
      `run: ${ID}, rearm of PR #7 in o/a`,
      "worktree: /w",
      "account: acct (claude)",
      "stage: rearm, alive",
      "running for 1h 2m",
    ]);
  });

  it("follows the spool and stops once the run has ended", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const spool = join(dir, "runs", ID, "output.log");
    mkdirSync(join(dir, "runs", ID), { recursive: true });
    writeFileSync(spool, "first\n");
    const run = fakeRun();
    let polls = 0;
    const code = await attachMain(
      ID,
      { takeOver: false },
      deps(dir, run, {
        sleep: async () => {
          polls += 1;
          appendFileSync(spool, `line ${polls}\n`);
          if (polls === 2) {
            run.alive = false;
            run.state = {
              kind: "ended",
              exit: { at: "2026-01-01T00:05:00.000Z", code: 0, signal: null },
              process: CLAIM,
            };
          }
        },
      }),
    );
    expect(code).toBe(0);
    expect(run.written.join("")).toBe("first\nline 1\nline 2\n");
    expect(run.out.at(-1)).toBe("the run has ended");
    expect(run.out).toContain("worktree: /w");
    expect(exitColumn(dir)).toBeNull();
  });

  it("detaches on an interrupt and leaves the run going", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const run = fakeRun();
    const controller = new AbortController();
    const code = await attachMain(
      ID,
      { takeOver: false },
      deps(dir, run, {
        signalAbort: controller.signal,
        sleep: async () => controller.abort(),
      }),
    );
    expect(code).toBe(0);
    expect(run.out.at(-1)).toBe("detached; the run goes on");
    expect(run.events).toEqual([]);
    expect(exitColumn(dir)).toBeNull();
  });

  it("finds its place again in a spool rewritten from its start", () => {
    const dir = root();
    const spool = join(dir, "output.log");
    const a = `${"a".repeat(299)}\n`;
    const b = `${"b".repeat(299)}\n`;
    writeFileSync(spool, a + b);
    const next = spoolCursor(spool);
    expect(String(next())).toBe(a + b);
    // Full: the wrapper keeps the newest tail and writes it from the start.
    writeFileSync(spool, `${b}cccc\n`);
    expect(String(next())).toBe("cccc\n");
    writeFileSync(spool, "zzzz\n");
    expect(String(next())).toContain("earlier output was skipped");
  });
});

describe("jig dispatch attach --take-over", () => {
  it("holds the target before it stops the run, then records the end by person", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const run = fakeRun();
    const code = await attachMain(ID, { takeOver: true }, deps(dir, run));
    expect(code).toBe(0);
    expect(run.events).toEqual([
      "hold drive@o/a#7 exit=none",
      "stop drive",
      "stop service",
    ]);
    expect(exitColumn(dir)).not.toBeNull();
    expect(reportBy(dir)).toBe("person");
    expect(existsSync(takeOverMark(dir, ID))).toBe(false);
    expect(run.out.at(-1)).toBe(
      "resume: cd /w && CLAUDE_CONFIG_DIR=/c claude --resume minted-session",
    );
  });

  it("leaves a closing report that passes the report check", async () => {
    const dir = root();
    writeRecord(record(), dir);
    await attachMain(ID, { takeOver: true }, deps(dir, fakeRun()));
    const row = stateDb(dir)
      .query("SELECT report FROM launches WHERE id = ?")
      .get(ID) as { report: string };
    expect(checkClosingReport(readKeptReport(row.report)?.report)).toEqual([]);
  });

  it("signals the recorded process groups when the unit's stop leaves them alive", async () => {
    const dir = root();
    writeRecord(record({ action: "followup" }), dir);
    const run = fakeRun();
    const code = await attachMain(
      ID,
      { takeOver: true },
      deps(dir, run, {
        stops: [async () => "no service manager runs it"],
        signal: async (_m, signal) => {
          run.events.push(signal);
          if (signal === "SIGKILL") run.alive = false;
          return "signalled";
        },
      }),
    );
    expect(code).toBe(0);
    expect(run.events).toEqual([
      "hold followup@o/a#7 exit=none",
      "SIGTERM",
      "SIGKILL",
    ]);
  });

  it("reconciles a live run after dying between the hold and the end", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const run = fakeRun();
    const crashing = deps(dir, run, {
      stops: [
        async () => {
          throw new Error("the command died");
        },
      ],
    });
    await expect(attachMain(ID, { takeOver: true }, crashing)).rejects.toThrow(
      "the command died",
    );
    expect(existsSync(takeOverMark(dir, ID))).toBe(true);
    expect(exitColumn(dir)).toBeNull();
    run.events.length = 0;
    const again = deps(dir, run, {
      hold: async (address) => {
        run.events.push(`hold ${address}`);
        return ok("already" as const);
      },
    });
    expect(await attachMain(ID, { takeOver: true }, again)).toBe(0);
    expect(run.events).toEqual([
      "hold drive@o/a#7",
      "stop drive",
      "stop service",
    ]);
    expect(run.out).toContain("hold: drive@o/a#7 was already held");
    expect(reportBy(dir)).toBe("person");
  });

  it("reconciles a run already stopped whose end was not recorded", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const run = fakeRun();
    const crashing = deps(dir, run, {
      stops: [
        async () => {
          run.alive = false;
          throw new Error("the command died");
        },
      ],
    });
    await expect(
      attachMain(ID, { takeOver: true }, crashing),
    ).rejects.toThrow();
    // The wrapper recorded its exit on the stop's signal, with no report by person.
    recordExit(
      ID,
      { at: "2026-01-01T00:06:00.000Z", code: null, signal: "SIGTERM" },
      dir,
    );
    run.events.length = 0;
    expect(await attachMain(ID, { takeOver: true }, deps(dir, run))).toBe(0);
    // Held again, and nothing left to stop.
    expect(run.events).toHaveLength(1);
    expect(run.events[0]).toStartWith("hold drive@o/a#7");
    expect(reportBy(dir)).toBe("person");
    expect(existsSync(takeOverMark(dir, ID))).toBe(false);
  });

  it("refuses a run that ended on its own, with no take-over begun", async () => {
    const dir = root();
    writeRecord(record(), dir);
    recordExit(
      ID,
      { at: "2026-01-01T00:06:00.000Z", code: 0, signal: null },
      dir,
    );
    const run = fakeRun();
    run.alive = false;
    expect(await attachMain(ID, { takeOver: true }, deps(dir, run))).toBe(2);
    expect(run.events).toEqual([]);
    expect(reportBy(dir)).toBeUndefined();
  });

  it("waits out no tick: with the lock held it exits 3, and a second run records the end", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const run = fakeRun();
    const lock = takeTickLock(dir);
    if ("heldBy" in lock) throw new Error("the lock was not taken");
    try {
      expect(await attachMain(ID, { takeOver: true }, deps(dir, run))).toBe(3);
    } finally {
      lock.release();
    }
    expect(exitColumn(dir)).toBeNull();
    expect(await attachMain(ID, { takeOver: true }, deps(dir, run))).toBe(0);
    expect(reportBy(dir)).toBe("person");
  });

  it("prints only the resume line again for a run a person already took over", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const run = fakeRun();
    await attachMain(ID, { takeOver: true }, deps(dir, run));
    run.events.length = 0;
    expect(await attachMain(ID, { takeOver: true }, deps(dir, run))).toBe(0);
    expect(run.events).toEqual([]);
    expect(run.out.at(-1)).toContain("claude --resume minted-session");
  });

  it("holds a pickup with the local hold the tick reads before it starts one", async () => {
    const dir = root();
    const pickup = record({ action: "pickup", pr: null, item: "ENG-1" });
    writeRecord(pickup, dir);
    const run = fakeRun();
    const code = await attachMain(
      ID,
      { takeOver: true },
      deps(dir, run, {
        hold: async (address) => {
          run.events.push(address);
          const written = setPersonPickupHold(
            "o/a",
            "ENG-1",
            { by: "person", title: "t", url: "u" },
            dir,
          );
          if (!written.ok) return written;
          return ok("held" as const);
        },
      }),
    );
    expect(code).toBe(0);
    expect(run.events[0]).toBe("pickup@o/a#ENG-1");
    expect(personPickupBlock(pickup, dir)).toContain("ENG-1 is held by person");
  });
});

describe("the resume line", () => {
  const facts = (over: Partial<LaunchRecord>, more = {}) => ({
    record: record(over),
    sessions: [],
    exit: null,
    ...more,
  });

  it("resumes a drive's last pass with Claude Code under the account's directory", () => {
    expect(
      resumeLine(
        facts(
          {},
          {
            sessions: [
              { round: 1, session: "s-1", at: "x" },
              { round: 2, session: "s-2", at: "y" },
            ],
          },
        ),
      ),
    ).toBe("cd /w && CLAUDE_CONFIG_DIR=/c claude --resume s-2");
  });

  it("resumes a Codex session whose id the run recorded", () => {
    expect(
      resumeLine(
        facts(
          { vendor: "codex", action: "pickup", sessionId: null },
          { exit: { session: "codex-77" } },
        ),
      ),
    ).toBe("cd /w && CODEX_HOME=/c codex resume codex-77");
  });

  it("says a Codex session with no recorded id cannot be resumed, naming the worktree", () => {
    expect(
      resumeLine(facts({ vendor: "codex", action: "pickup", sessionId: null })),
    ).toBe(
      "The Codex session recorded no id, so it cannot be resumed; its worktree is /w",
    );
  });
});

describe("a run's target address", () => {
  it("names the station that holds each kind of run", () => {
    expect(targetAddress(record())).toBe("drive@o/a#7");
    expect(targetAddress(record({ action: "takeover" }))).toBe("drive@o/a#7");
    expect(targetAddress(record({ action: "followup" }))).toBe(
      "followup@o/a#7",
    );
    expect(
      targetAddress(record({ action: "pickup", pr: null, item: "ENG-1" })),
    ).toBe("pickup@o/a#ENG-1");
    expect(targetAddress(record({ action: "steward", pr: null }))).toBeNull();
  });
});
