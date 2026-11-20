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

const DESCENDANT: ProcessIdentity = { ...CLAIM, pid: 4343, start: "d" };

/** A fake run: its state and liveness, which the suite moves on. */
interface Run {
  state: LaunchState;
  alive: boolean;
  events: string[];
  out: string[];
  err: string[];
  written: string[];
  /** A descendant of the run the stop reparents, which outlives its recorded processes. */
  descendantAlive: boolean;
  /** The records whose forge claim end was written, and the failures that settle reports. */
  settled: string[];
  settleFailures: string[];
  /** What the take-over signalled, per signal. */
  signalled: ProcessIdentity[][];
}

function fakeRun(): Run {
  return {
    state: { kind: "alive", process: CLAIM },
    alive: true,
    events: [],
    out: [],
    err: [],
    written: [],
    descendantAlive: false,
    settled: [],
    settleFailures: [],
    signalled: [],
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
    tree: async (members) => [...members, DESCENDANT],
    anyAlive: async (members) =>
      members.some(
        (m) =>
          (m.pid === CLAIM.pid && run.alive) ||
          (m.pid === DESCENDANT.pid && run.descendantAlive),
      ),
    settleClaims: async (id) => {
      run.settled.push(id);
      return run.settleFailures;
    },
    signal: async (members, signal) => {
      run.events.push(signal);
      run.signalled.push(members);
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

  it("says why when the spool exists but cannot be read", async () => {
    if (process.getuid?.() === 0) return; // root reads a file of mode 000
    const dir = root();
    writeRecord(record(), dir);
    const spool = join(dir, "runs", ID, "output.log");
    mkdirSync(join(dir, "runs", ID), { recursive: true });
    writeFileSync(spool, "secret\n", { mode: 0o000 });
    const run = fakeRun();
    // A watch that missed the failure would poll on: detach it after a few reads.
    const controller = new AbortController();
    let polls = 0;
    const watched = deps(dir, run, {
      signalAbort: controller.signal,
      sleep: async () => {
        polls += 1;
        if (polls === 3) controller.abort();
      },
    });
    expect(await attachMain(ID, { takeOver: false }, watched)).toBe(1);
    expect(run.err.join("\n")).toContain("EACCES");
    expect(run.written).toEqual([]);
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

  it("does not lose a rewrite that ends with the same bytes as the last read", () => {
    const dir = root();
    const spool = join(dir, "output.log");
    const tail = `${"x".repeat(299)}\n`;
    writeFileSync(spool, `${"a".repeat(99)}\n${tail}`);
    const next = spoolCursor(spool);
    next();
    writeFileSync(spool, `${"b".repeat(99)}\n${tail}`);
    expect(String(next())).toContain("b".repeat(99));
    next.close();
  });

  it("follows a rewritten repetitive spool in linear time", () => {
    const dir = root();
    const spool = join(dir, "output.log");
    const prev = `${"a\n".repeat(1_000_000)}b\n`;
    writeFileSync(spool, prev);
    const next = spoolCursor(spool);
    next();
    writeFileSync(spool, `${prev.slice(2)}c\n`);
    const started = performance.now();
    expect(String(next())).toBe("c\n");
    expect(performance.now() - started).toBeLessThan(2000);
    next.close();
  });

  it("reads output flushed before the spool was deleted", () => {
    const dir = root();
    const spool = join(dir, "output.log");
    writeFileSync(spool, "one\n");
    const next = spoolCursor(spool);
    expect(String(next())).toBe("one\n");
    appendFileSync(spool, "two\n");
    rmSync(spool);
    expect(String(next())).toBe("two\n");
    next.close();
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

  it("fails closed when the saved processes cannot be read", async () => {
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
    writeFileSync(join(dir, "runs", ID, "take-over-members.json"), "{not json");
    expect(await attachMain(ID, { takeOver: true }, deps(dir, run))).toBe(1);
    expect(run.err.join("\n")).toContain("cannot be read");
    expect(exitColumn(dir)).toBeNull();
  });

  it("retries a failed drive stop on the next attempt before recording the end", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const run = fakeRun();
    const failing = deps(dir, run, {
      stops: [
        async () => ({
          note: "drives.ts --stop failed",
          failed: true as const,
        }),
        async () => {
          run.alive = false;
          return "unit stopped";
        },
      ],
    });
    expect(await attachMain(ID, { takeOver: true }, failing)).toBe(1);
    expect(exitColumn(dir)).toBeNull();
    run.events.length = 0;
    expect(await attachMain(ID, { takeOver: true }, deps(dir, run))).toBe(0);
    expect(run.events).toContain("stop drive");
    expect(reportBy(dir)).toBe("person");
  });

  it("keeps the drive stop owed when the attempt dies before the stop finishes", async () => {
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
    expect(existsSync(join(dir, "runs", ID, "take-over-drive-stop"))).toBe(
      true,
    );
    run.events.length = 0;
    expect(await attachMain(ID, { takeOver: true }, deps(dir, run))).toBe(0);
    expect(run.events).toContain("stop drive");
    expect(existsSync(join(dir, "runs", ID, "take-over-drive-stop"))).toBe(
      false,
    );
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
    // Held again; the drive's stop was owed when the first attempt died, so it runs once more.
    expect(run.events[0]).toStartWith("hold drive@o/a#7");
    expect(run.events).toContain("stop drive");
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
    expect(run.err.join("\n")).toContain(
      "A hold from an earlier take-over may still stand on drive@o/a#7: jig send 'drive@o/a#7' release releases it",
    );
  });

  it("keeps the mark and names jig dispatch clear when the ended record still holds its slot", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const run = fakeRun();
    const unknown: LaunchState = {
      kind: "unknown",
      reason: "the stage cleanup could not be confirmed",
      process: CLAIM,
      unjudged: true,
    };
    const base = deps(dir, run);
    const code = await attachMain(
      ID,
      { takeOver: true },
      {
        ...base,
        inspect: async (id) => {
          const row = await base.inspect(id);
          return row !== null && row.exit !== null
            ? { ...row, state: unknown }
            : row;
        },
      },
    );
    expect(code).toBe(1);
    expect(run.err.join("\n")).toContain(`jig dispatch clear ${ID}`);
    expect(run.out.join("\n")).not.toContain("slot is free");
    expect(existsSync(takeOverMark(dir, ID))).toBe(true);
    expect(run.settled).toEqual([]);
  });

  it("writes the end onto the forge's launch claim after recording it, and says when it could not", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const run = fakeRun();
    run.settleFailures = ["PR #7: the forge did not answer"];
    expect(await attachMain(ID, { takeOver: true }, deps(dir, run))).toBe(0);
    expect(run.settled).toEqual([ID]);
    expect(run.out.join("\n")).toContain(
      "not yet on the forge's launch claim, which the next tick writes: PR #7: the forge did not answer",
    );
  });

  it("waits for and signals the descendants it captured before the stop", async () => {
    const dir = root();
    writeRecord(record(), dir);
    const run = fakeRun();
    run.descendantAlive = true;
    const code = await attachMain(
      ID,
      { takeOver: true },
      deps(dir, run, {
        signal: async (members, signal) => {
          run.events.push(signal);
          run.signalled.push(members);
          run.descendantAlive = false;
          return "signalled";
        },
      }),
    );
    expect(code).toBe(0);
    expect(run.events).toEqual([
      "hold drive@o/a#7 exit=none",
      "stop drive",
      "stop service",
      "SIGTERM",
    ]);
    expect(run.signalled[0]?.map((m) => m.pid)).toEqual([
      CLAIM.pid,
      DESCENDANT.pid,
    ]);
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
