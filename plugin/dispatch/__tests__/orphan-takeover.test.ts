/**
 * dispatch --apply: a drive whose ledger fell silent past the lease window,
 * and whose driver no launch record of this machine and no launch claim of
 * another host started, is taken over when the repository clone's drive
 * doctor reads its holder dead or wedged, and reported otherwise. The doctor
 * is a fake that prints the rows `drives.ts --json` would; the drive is the
 * suite's fake `drive.ts`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { orphanTakeover, parseHolders } from "../lib/sources/doctor.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  labeled,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  driveRuns,
  exitWritten,
  machineFile,
  terminalCreates,
  waitFor,
} from "./launch-fixtures.ts";

const config = (extra = "") => `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
${extra}`;

const HEAD = "feature/7-silent";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** PR #7 whose ledger names a running driver silent for days, its workspace, and account a. */
function fixture(yaml = config(), labels: string[] = []): World {
  const w = world();
  current = w;
  w.setConfig(yaml);
  const pr = openPr(7, HEAD);
  w.setPrs("open", [labels.length === 0 ? pr : labeled(pr, ...labels)]);
  const ledger = stoppedLedger(7, undefined);
  w.setComments(7, [
    ledgerComment(701, {
      ...ledger,
      driver: {
        ...ledger.driver,
        state: "running",
        started: "2026-10-30T21:30:00.000Z",
        heartbeat: "2026-10-30T22:00:00.000Z",
      },
    }),
  ]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: ws }]);
  machineFile(w, [{ ...account(w, "a", "a@example.com"), max: 1 }]);
  return w;
}

/** What the clone's drive doctor reads of PR #7's holder; no call leaves it with no rows. */
function doctorReads(
  w: World,
  holder: { state: string; verdict: string; reason: string },
): void {
  writeFileSync(
    join(w.dir, "doctor.json"),
    JSON.stringify({
      stateDir: "/state",
      rows: [
        {
          kind: "pr",
          key: "7",
          state: holder.state,
          doctor: {
            verdict: holder.verdict,
            reason: holder.reason,
            recovery: null,
          },
        },
      ],
    }),
  );
}

/** Each run of the fake doctor, by its working directory. */
function doctorRuns(w: World): Array<{ argv: string[]; cwd: string }> {
  const path = join(w.dir, "doctor-runs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { argv: string[]; cwd: string });
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const repo = (r: TickReceipt) => r.repos[0];

const VANISHED =
  "no live driver: its process is gone, and its worktree /ws/gone no longer exists, so its working files cannot be inspected; commits may remain in shared Git storage — inspect branch refs and reflogs before redoing work; a takeover is admitted";

describe("a silent driver no launch started", () => {
  for (const holder of [
    { state: "stale", verdict: "DEAD", reason: VANISHED },
    {
      state: "live",
      verdict: "WEDGED",
      reason:
        "no recorded progress for 300 minute(s) (threshold 240) and no pass process is running under this driver",
    },
  ])
    it(`is taken over once this clone's doctor reads its holder ${holder.verdict}`, async () => {
      const w = fixture();
      doctorReads(w, holder);
      const receipt = await tick(w);
      expect(repo(receipt)?.actions).toContainEqual(
        expect.objectContaining({
          stage: "rearm",
          target: "PR #7",
          reason: `drive ledger silent, no launch started its driver, and this clone's drive doctor reads its holder ${holder.verdict} (${holder.reason}): take it over (drive.ts --take-over decides)`,
          takeoverHolder: {
            verdict: holder.verdict,
            reason: holder.reason,
            lock: holder.state,
          },
        }),
      );
      const [launched] = repo(receipt)?.launches ?? [];
      expect(launched).toMatchObject({
        action: "takeover",
        outcome: "launched",
        account: "a",
      });
      await waitFor("the drive", () => driveRuns(w).length === 1);
      expect(driveRuns(w)[0]?.argv.slice(0, 2)).toEqual(["7", "--take-over"]);
      await waitFor("the exit", () => exitWritten(w, launched?.record ?? ""));
      // The doctor was read in the repository's clone.
      expect(doctorRuns(w)).toEqual([{ argv: ["--json"], cwd: w.repo }]);
    });

  it("is never taken over while its holder is alive and making progress", async () => {
    const w = fixture();
    const reason = "a pass is currently running; last progress 3 minute(s) ago";
    doctorReads(w, { state: "live", verdict: "HEALTHY", reason });
    const receipt = await tick(w);
    expect(repo(receipt)?.launches).toEqual([]);
    expect(terminalCreates(w)).toHaveLength(0);
    const action = repo(receipt)?.actions.find((a) => a.target === "PR #7");
    expect(action?.stage).toBe("notify");
    expect(action?.reason).toContain(
      `this clone's drive doctor reads its holder HEALTHY (${reason}): only a dead or wedged holder is taken over, so it is reported`,
    );
    // The person's notification carries the doctor's reading too.
    expect(action?.notice?.text).toContain(`holder HEALTHY (${reason})`);
  });

  it("is reported when no driver of this clone holds its lock", async () => {
    const w = fixture();
    const receipt = await tick(w);
    expect(repo(receipt)?.launches).toEqual([]);
    const action = repo(receipt)?.actions.find((a) => a.target === "PR #7");
    expect(action?.stage).toBe("notify");
    expect(action?.reason).toContain(
      "no driver of this clone holds its lock (its driver ran in another clone, which this host's doctor cannot read), so it is reported, not taken over",
    );
  });

  it("is left alone while a person's hold label is on it", async () => {
    const w = fixture(config("dispatch:\n  labels: { enabled: true }\n"), [
      "jig:hold",
    ]);
    doctorReads(w, { state: "stale", verdict: "DEAD", reason: VANISHED });
    const receipt = await tick(w);
    expect(repo(receipt)?.actions).toEqual([]);
    expect(repo(receipt)?.launches).toEqual([]);
    expect(repo(receipt)?.labels?.held).toContainEqual(
      expect.objectContaining({ target: "PR #7", stage: "rearm" }),
    );
    expect(driveRuns(w)).toEqual([]);
  });
});

describe("the doctor's reading", () => {
  const silent = {
    number: 7,
    url: "",
    title: "",
    head: HEAD,
    class: "silent" as const,
    why: "heartbeat 300 min old, past the 240-min lease window",
    evidence: {},
  };

  it("reports a drive whose doctor output does not read, naming why", () => {
    const holders = parseHolders("not json");
    expect(holders.ok).toBe(false);
    const read = orphanTakeover(silent, holders);
    expect("why" in read ? read.why : "").toContain(
      "this clone's drive doctor could not be read (its output is not JSON",
    );
  });

  it("reads each pull-request row's verdict and lock, and only those", () => {
    const holders = parseHolders(
      JSON.stringify({
        rows: [
          { kind: "worktree", key: "ab12", state: "stale", doctor: null },
          {
            kind: "pr",
            key: "7",
            state: "stale",
            doctor: { verdict: "DEAD", reason: "gone" },
          },
        ],
      }),
    );
    expect(holders.ok ? [...holders.value] : []).toEqual([
      [7, { verdict: "DEAD", reason: "gone", lock: "stale" }],
    ]);
    expect(orphanTakeover(silent, holders)).toEqual({
      holder: { verdict: "DEAD", reason: "gone", lock: "stale" },
    });
  });
});
