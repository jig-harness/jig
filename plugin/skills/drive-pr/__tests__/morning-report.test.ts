/**
 * `drives.ts --report`: the morning report over a fixture state directory
 * and the fake forge in `provisional-fixtures.ts`, holding one of each kind
 * of entry: provisional decisions (one a person reversed on its thread, one
 * standing), a takeover, a re-arm, a framed park, an issue filed and a
 * deferred entry not yet filed; a pull request known only through its
 * ledger; another account's pull request and a quiet local state, both left
 * out. Then the time the report remembers for the next one.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { withDeferredEntry } from "../../resolve-review-comments/scripts/lib/deferred-section.ts";
import { REPORT_MEMORY } from "../scripts/lib/morning-report.ts";
import { ledgerFromState, renderLedger } from "../scripts/lib/state/ledger.ts";
import { type DriveState, freshState } from "../scripts/lib/state/schema.ts";
import { provisionalBody } from "../scripts/provisional-reply.ts";
import {
  fakeForge,
  type Forge,
  runIn,
  SCRIPTS,
} from "./provisional-fixtures.ts";

const ago = (hours: number) =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

const FINDING = {
  author: "review-bot[bot]",
  association: "NONE",
  body: "Raise the budget.",
};
const PROVISIONAL = {
  author: "drive-bot",
  association: "MEMBER",
  body: provisionalBody(
    "**wont-fix** — the budget is the configured one.",
    "escalated",
  ),
};

function decision(key: string, hoursAgo: number) {
  return {
    at: ago(hoursAgo),
    round: 2,
    level: "wide",
    class: "provisional-reply",
    what: `kept the configured budget on ${key}`,
    record: `https://example.invalid/${key}/comment-1`,
    reverse: "comment on the thread as an owner, member or collaborator",
    key,
    outcome: "wont-fix",
  };
}

function writeState(forge: Forge, state: DriveState): string {
  const file = join(forge.stateDir, `drive-pr-${state.pr}.json`);
  writeFileSync(file, JSON.stringify(state));
  return file;
}

function setUp(): Forge {
  const forge = fakeForge("");
  forge.write("login", "drive-bot");
  writeState(forge, {
    ...freshState(12),
    rounds: 3,
    decisions: [
      decision("PRRT_a", 6),
      decision("PRRT_b", 5),
      {
        at: ago(7),
        round: 1,
        level: "unattended",
        class: "file-issue",
        what: "filed the follow-up for the retry budget",
        record: "https://example.invalid/issues/7",
        reverse: "close the issue",
      },
    ],
    takeovers: [
      {
        at: ago(8),
        fromActor: "wt-aaaaaaaaaaaaaaaa",
        fromAccount: null,
        toActor: "wt-bbbbbbbbbbbbbbbb",
        toAccount: null,
        verdict: "WEDGED",
        round: 2,
        reopened: [],
      },
    ],
    events: [{ at: ago(4), round: 3, kind: "rearm", cause: "answered" }],
    parked: [
      {
        key: "PRRT_c",
        kind: "thread",
        reason: "Should the public flag be renamed?",
        round: 3,
        at: ago(3),
        class: "copy",
        record:
          "## Question\n\nShould the public flag be renamed?\n\n## Recommended\n\n**Keep it**: published.",
      },
    ],
  } as DriveState);
  // A quiet local state from long ago: nothing to say.
  const quiet = writeState(forge, freshState(13));
  utimesSync(
    quiet,
    new Date(Date.now() - 400 * 86400000),
    new Date(Date.now() - 400 * 86400000),
  );
  forge.thread("PRRT_a", [
    FINDING,
    PROVISIONAL,
    {
      author: "lead",
      association: "OWNER",
      body: "Raise it after all.",
      at: ago(2),
    },
  ]);
  forge.thread("PRRT_b", [FINDING, PROVISIONAL]);
  forge.write("comments-12.json", []);
  forge.write("pr-12.json", {
    title: "Raise the retry budget",
    url: "https://example.invalid/pull/12",
    state: "OPEN",
    author: { login: "drive-bot" },
    body: withDeferredEntry("Summary.", {
      source: "https://example.invalid/PRRT_d",
      finding: "The parser ignores a trailing comma.",
      reason: "out of scope",
    }).body,
  });
  // Pull request 20 is known only through its ledger, which this account wrote.
  const ledger = renderLedger(
    ledgerFromState(
      { ...freshState(20), rounds: 4, phase: "converged" },
      {
        generation: 3,
        driver: {
          actor: "wt-cccccccccccccccc",
          clone: "clone-b",
          heartbeat: ago(1),
          state: "stopped",
          exit: 0,
        },
        narrative: [],
        claims: [],
      },
    ),
  );
  if ("error" in ledger) throw new Error(ledger.error);
  const comment = (id: number, login: string, association: string) => ({
    id,
    body: ledger.body,
    user: { login },
    author_association: association,
    updated_at: ago(1),
    created_at: ago(1),
    html_url: `https://example.invalid/comment-${id}`,
  });
  forge.write("comments-20.json", [comment(200, "drive-bot", "NONE")]);
  // Pull request 21 is another account's, driven by another account.
  forge.write("comments-21.json", [comment(210, "other-bot", "MEMBER")]);
  forge.write("search.json", {
    items: [
      {
        number: 20,
        html_url: "https://example.invalid/pull/20",
        title: "Ledger only",
        user: { login: "drive-bot" },
      },
      {
        number: 21,
        html_url: "https://example.invalid/pull/21",
        title: "Not ours",
        user: { login: "someone" },
      },
    ],
  });
  forge.write("pr-20.json", {
    title: "Ledger only",
    url: "https://example.invalid/pull/20",
    state: "OPEN",
    author: { login: "drive-bot" },
    body: "",
  });
  return forge;
}

const report = (forge: Forge, args: string[]) =>
  runIn(forge, join(SCRIPTS, "drives.ts"), ["--report", ...args]);

describe("drives.ts --report", () => {
  it("--json carries each kind of entry for this clone's and this account's pull requests", async () => {
    const forge = setUp();
    const r = await report(forge, ["--json"]);
    expectSpawnExit(r, 0);
    const out = JSON.parse(r.stdout);
    expect(out.sinceSource).toBe("first report");
    expect(out.unread).toEqual([]);
    expect(out.pullRequests.map((p: { number: number }) => p.number)).toEqual([
      12, 20,
    ]);
    const [twelve, twenty] = out.pullRequests;
    expect(twelve.terminal.name).toBe("HITL_PARKED");
    expect(
      twelve.provisional.map((p: { key: string; status: string }) => [
        p.key,
        p.status,
      ]),
    ).toEqual([
      ["PRRT_a", "reversed"],
      ["PRRT_b", "standing"],
    ]);
    expect(twelve.provisional[0].reversedBy).toBe("lead");
    expect(twelve.takeovers).toHaveLength(1);
    expect(twelve.rearms).toEqual([
      expect.objectContaining({ cause: "answered" }),
    ]);
    expect(twelve.parked[0]).toMatchObject({ key: "PRRT_c", class: "copy" });
    expect(twelve.issuesFiled[0].record).toBe(
      "https://example.invalid/issues/7",
    );
    expect(twelve.deferredUnfiled[0].source).toBe(
      "https://example.invalid/PRRT_d",
    );
    expect(twelve.deferredUnfiled[0].text).toContain("trailing comma");
    expect(twenty).toMatchObject({
      source: "ledger",
      terminal: { name: "CONVERGED", exit: 0 },
    });
  });

  it("prints plain text with the provisional decisions first, and remembers its time for the next one", async () => {
    const forge = setUp();
    const first = await report(forge, []);
    expectSpawnExit(first, 0);
    const text = first.stdout;
    expect(text).toContain("no earlier report is remembered here");
    const provisional = text.indexOf("Provisional decisions");
    expect(provisional).toBeGreaterThan(-1);
    expect(provisional).toBeLessThan(
      text.indexOf("#12 Raise the retry budget"),
    );
    expect(text).toContain("REVERSED by lead");
    expect(text).toContain(
      "HITL_PARKED: only the parked decisions below remain",
    );
    expect(text).toContain("class copy");
    expect(text).toContain("deferred, not yet filed:");
    expect(text).toContain("CONVERGED (exit 0): the review settled");

    const second = await report(forge, ["--json"]);
    expectSpawnExit(second, 0);
    const again = JSON.parse(second.stdout);
    expect(again.sinceSource).toBe("last report");
    expect(Date.parse(again.since)).toBeGreaterThan(Date.parse(ago(1)));
    // What happened before the last report is not news; what is still owed is.
    const twelve = again.pullRequests.find(
      (p: { number: number }) => p.number === 12,
    );
    expect(twelve.takeovers).toEqual([]);
    expect(twelve.issuesFiled).toEqual([]);
    expect(twelve.parked).toHaveLength(1);
  });

  it("reads how a drive this clone ran ended from its state", async () => {
    const forge = setUp();
    writeState(forge, {
      ...freshState(14),
      rounds: 4,
      events: [{ at: ago(2), round: 4, kind: "stop", cause: "0" }],
    } as DriveState);
    forge.write("pr-14.json", {
      title: "Converged here",
      url: "https://example.invalid/pull/14",
      state: "OPEN",
      author: { login: "drive-bot" },
      body: "",
    });
    const r = await report(forge, ["--json"]);
    expectSpawnExit(r, 0);
    const fourteen = JSON.parse(r.stdout).pullRequests.find(
      (p: { number: number }) => p.number === 14,
    );
    expect(fourteen).toMatchObject({
      source: "state",
      terminal: { name: "CONVERGED", exit: 0 },
    });
  });

  it("says when the ledger search failed, and then does not move the next report's start", async () => {
    const forge = setUp();
    forge.write("fail-search", "");
    const r = await report(forge, ["--json"]);
    expectSpawnExit(r, 0);
    const out = JSON.parse(r.stdout);
    expect(out.unread.join("\n")).toContain(
      "search for drive ledgers could not be run",
    );
    expect(out.pullRequests.map((p: { number: number }) => p.number)).toEqual([
      12,
    ]);
    expect(existsSync(join(forge.stateDir, REPORT_MEMORY))).toBe(false);
  });

  it("a --since look does not move the next report's start", async () => {
    const forge = setUp();
    expectSpawnExit(await report(forge, ["--since", "2h", "--json"]), 0);
    expect(existsSync(join(forge.stateDir, REPORT_MEMORY))).toBe(false);
    expectSpawnExit(await report(forge, ["--json"]), 0);
    expect(existsSync(join(forge.stateDir, REPORT_MEMORY))).toBe(true);
  });

  it("names the command that files the deferred entries", async () => {
    const forge = setUp();
    const r = await report(forge, []);
    expectSpawnExit(r, 0);
    expect(r.stdout).toMatch(/file them: bun ".*file-deferred\.ts" 12/);
  });

  it("--since overrides the remembered time, and refuses a time it cannot read", async () => {
    const forge = setUp();
    const r = await report(forge, ["--since", "5h30m"]);
    expectSpawnExit(r, 2);
    const ok = await report(forge, ["--since", "4h", "--json"]);
    expectSpawnExit(ok, 0);
    const out = JSON.parse(ok.stdout);
    expect(out.sinceSource).toBe("flag");
    const twelve = out.pullRequests.find(
      (p: { number: number }) => p.number === 12,
    );
    // PRRT_b, decided before the four hours, still stands: it is listed
    // whatever its age.
    expect(twelve.provisional.map((p: { key: string }) => p.key)).toEqual([
      "PRRT_a",
      "PRRT_b",
    ]);
    expect(twelve.rearms).toEqual([]);
  });

  it("lists an authored pull request with no drive ledger, for its deferred entries", async () => {
    const forge = setUp();
    forge.write("search.json", {
      items: [
        {
          number: 30,
          html_url: "https://example.invalid/pull/30",
          title: "Authored, never driven",
          user: { login: "drive-bot" },
        },
      ],
    });
    forge.write("pr-30.json", {
      title: "Authored, never driven",
      url: "https://example.invalid/pull/30",
      state: "OPEN",
      author: { login: "drive-bot" },
      body: withDeferredEntry("Summary.", {
        source: "https://example.invalid/PRRT_e",
        finding: "The cache is never evicted.",
        reason: "out of scope",
      }).body,
    });
    const r = await report(forge, ["--json"]);
    expectSpawnExit(r, 0);
    const thirty = JSON.parse(r.stdout).pullRequests.find(
      (p: { number: number }) => p.number === 30,
    );
    expect(thirty.deferredUnfiled[0].source).toBe(
      "https://example.invalid/PRRT_e",
    );
  });

  it("an unreadable reversal is said, and the report's time is not remembered", async () => {
    const forge = setUp();
    rmSync(join(forge.dir, "thread-PRRT_b.json"));
    const r = await report(forge, ["--json"]);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).unread.join("\n")).toContain(
      "provisional decision on PRRT_b could not be read",
    );
    expect(existsSync(join(forge.stateDir, REPORT_MEMORY))).toBe(false);
  });

  it("a ledger of a later generation than this clone's state speaks for the pull request", async () => {
    const forge = setUp();
    writeState(forge, {
      ...freshState(20),
      ledgerGeneration: 1,
      events: [{ at: ago(2), round: 1, kind: "stop", cause: "8" }],
    } as DriveState);
    const r = await report(forge, ["--json"]);
    expectSpawnExit(r, 0);
    const twenty = JSON.parse(r.stdout).pullRequests.find(
      (p: { number: number }) => p.number === 20,
    );
    expect(twenty).toMatchObject({
      source: "ledger",
      terminal: { name: "CONVERGED", exit: 0 },
    });
  });

  it("a running ledger whose heartbeat is past the lease window is not a running drive", async () => {
    const run = async (heartbeatHoursAgo: number) => {
      const forge = setUp();
      const ledger = renderLedger(
        ledgerFromState(
          { ...freshState(20), rounds: 4, phase: "converged" },
          {
            generation: 3,
            driver: {
              actor: "wt-cccccccccccccccc",
              clone: "clone-b",
              heartbeat: ago(heartbeatHoursAgo),
              state: "running",
            },
            narrative: [],
            claims: [],
          },
        ),
      );
      if ("error" in ledger) throw new Error(ledger.error);
      forge.write("comments-20.json", [
        {
          id: 200,
          body: ledger.body,
          user: { login: "drive-bot" },
          author_association: "NONE",
          updated_at: ago(1),
          created_at: ago(1),
          html_url: "https://example.invalid/comment-200",
        },
      ]);
      const r = await report(forge, ["--json"]);
      expectSpawnExit(r, 0);
      return JSON.parse(r.stdout).pullRequests.find(
        (p: { number: number }) => p.number === 20,
      );
    };
    expect((await run(1)).terminal.name).toBe("running");
    expect((await run(24 * 30)).terminal.name).not.toBe("running");
  });

  it("a stop that ended an earlier run does not end the run a lapsed ledger names", async () => {
    const run = async (startedHoursAgo: number) => {
      const forge = setUp();
      writeState(forge, {
        ...freshState(20),
        ledgerGeneration: 3,
        events: [{ at: ago(10), round: 1, kind: "stop", cause: "0" }],
      } as DriveState);
      const ledger = renderLedger(
        ledgerFromState(
          { ...freshState(20), rounds: 4, phase: "converged" },
          {
            generation: 3,
            driver: {
              actor: "wt-cccccccccccccccc",
              clone: "clone-b",
              heartbeat: ago(24 * 30),
              state: "running",
              started: ago(startedHoursAgo),
            },
            narrative: [],
            claims: [],
          },
        ),
      );
      if ("error" in ledger) throw new Error(ledger.error);
      forge.write("comments-20.json", [
        {
          id: 200,
          body: ledger.body,
          user: { login: "drive-bot" },
          author_association: "NONE",
          updated_at: ago(1),
          created_at: ago(1),
          html_url: "https://example.invalid/comment-200",
        },
      ]);
      const r = await report(forge, ["--json"]);
      expectSpawnExit(r, 0);
      return JSON.parse(r.stdout).pullRequests.find(
        (p: { number: number }) => p.number === 20,
      );
    };
    // The run began after the recorded stop: that stop is not its end.
    expect((await run(5)).terminal.name).toBe("stopped");
    // The run began before it: the stop is that run's end.
    expect((await run(20)).terminal).toMatchObject({
      name: "CONVERGED",
      exit: 0,
    });
  });

  it("a ledger's own earlier stop does not end the run it names, with or without local state", async () => {
    const run = async (
      startedHoursAgo: number,
      localGeneration: number | null,
    ) => {
      const forge = setUp();
      if (localGeneration !== null)
        writeState(forge, {
          ...freshState(20),
          ledgerGeneration: localGeneration,
        } as DriveState);
      const ledger = renderLedger(
        ledgerFromState(
          {
            ...freshState(20),
            rounds: 4,
            phase: "converged",
            events: [{ at: ago(10), round: 1, kind: "stop", cause: "0" }],
          } as DriveState,
          {
            generation: 3,
            driver: {
              actor: "wt-cccccccccccccccc",
              clone: "clone-b",
              heartbeat: ago(24 * 30),
              state: "running",
              started: ago(startedHoursAgo),
            },
            narrative: [],
            claims: [],
          },
        ),
      );
      if ("error" in ledger) throw new Error(ledger.error);
      forge.write("comments-20.json", [
        {
          id: 200,
          body: ledger.body,
          user: { login: "drive-bot" },
          author_association: "NONE",
          updated_at: ago(1),
          created_at: ago(1),
          html_url: "https://example.invalid/comment-200",
        },
      ]);
      const r = await report(forge, ["--json"]);
      expectSpawnExit(r, 0);
      return JSON.parse(r.stdout).pullRequests.find(
        (p: { number: number }) => p.number === 20,
      );
    };
    for (const local of [null, 1]) {
      // The run began after the stop: it has recorded none of its own.
      expect((await run(5, local)).terminal.name).toBe("stopped");
      // The run began before it: the stop is that run's end.
      expect((await run(20, local)).terminal).toMatchObject({
        name: "CONVERGED",
        exit: 0,
      });
    }
  });

  it("a stop followed by a re-arm is not how the drive ended", async () => {
    const forge = setUp();
    writeState(forge, {
      ...freshState(20),
      ledgerGeneration: 3,
      events: [
        { at: ago(10), round: 1, kind: "stop", cause: "0" },
        { at: ago(5), round: 2, kind: "rearm", cause: "answered" },
      ],
    } as DriveState);
    const r = await report(forge, ["--json"]);
    expectSpawnExit(r, 0);
    const twenty = JSON.parse(r.stdout).pullRequests.find(
      (p: { number: number }) => p.number === 20,
    );
    expect(twenty.terminal.name).toBe("stopped");
  });

  it("a span too long for a date is refused as usage", async () => {
    const forge = setUp();
    const r = await report(forge, ["--since", "999999999999999999999h"]);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain(
      "--since takes an ISO-8601 time or a span such as 12h or 2d",
    );
  });
});
