/**
 * drive-pr suite: the drive's own pull request state label. With
 * `dispatch.labels` on and no dispatcher anywhere, a drive writes `driving`
 * (removing the `drive` command) once its running ledger is out and before
 * its first round, `converged` when it stops `CONVERGED` and `parked` when it
 * parks, each replacing the state label before it; a refused converged label
 * write requires another drive to settle CI; a pull request carrying `hold` or `held` is
 * left as it is. A `gh` placed ahead of the suite's stub forge answers the
 * label read and edit from a file and passes every other call through.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  binDir,
  type Fixture,
  makeScratchRepo,
  park,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { PASS_NOOP, runDriveIn } from "./drive-loop-harness.ts";
import { labelForge } from "./state-labels-forge.ts";
import { DRIVE_EXIT } from "../scripts/lib/status/terminal-states.ts";
import { CONVERGED_CI_PHASE } from "../scripts/lib/state/ledger-values.ts";
import { currentMs, parseMs } from "../../../shared/time.ts";
import { type DriveEvent, stopInstant } from "../scripts/lib/state/events.ts";
import { parseLedger } from "../scripts/lib/state/ledger.ts";
import { driverRecordRow, readState } from "./state-rows.ts";

useDrivePrSuite();

const LEDGER_ON = { DRIVE_PR_LEDGER: "on" };
let seq = 0;

/** A fixture in a tree of its own, its pull request carrying `labels`. */
function labelled(f: Fixture, labels: string[]) {
  const tree = makeScratchRepo(`state-labels-${++seq}`);
  const { dir, stateDir } = writeFixture(
    { reviewedSha: tree.head, head: tree.head, ...f },
    tree.dir,
  );
  const forge = labelForge(dir, join(binDir, "gh"), labels, tree.head);
  return { dir, stateDir, tree: tree.dir, ...forge };
}

async function drive(
  run: ReturnType<typeof labelled>,
  pass: string[],
  flags: string[] = [],
  env: Record<string, string> = LEDGER_ON,
) {
  return runDriveIn(
    run.dir,
    run.stateDir,
    ["--no-head-sync", ...flags, "--", ...pass],
    run.tree,
    { env, extraBinDir: run.bin },
  );
}

describe("a drive writes its own state label", () => {
  it("arms an unlabelled pull request with driving, without drive, before its first round", async () => {
    const run = labelled(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      ["jig:drive", "area:docs"],
    );
    const seen = join(run.bin, "labels-at-pass.json");
    const pass = [
      "sh",
      "-c",
      `cp "${join(run.bin, "labels.json")}" "${seen}"; : pass for 999`,
    ];
    const r = await drive(run, pass, ["--max-rounds", "1"]);
    expectSpawnExit({ ...r, stdout: null }, 6);
    // What the pull request carried when the first round's pass ran.
    expect(JSON.parse(readFileSync(seen, "utf8")).sort()).toEqual([
      "area:docs",
      "jig:driving",
    ]);
    expect(run.edits()[0]).toEqual({
      add: ["jig:driving"],
      remove: ["jig:drive"],
    });
    expect(r.stderr).toContain(
      "labels: PR #999's state label written: +jig:driving -jig:drive",
    );
    // MAX_ROUNDS is a stop only a person settles: parked replaces driving.
    expect(run.labels().sort()).toEqual(["area:docs", "jig:parked"]);
  });

  it("replaces the state label with converged when it stops CONVERGED", async () => {
    const run = labelled({ threads: [] }, ["jig:stale"]);
    const r = await drive(run, PASS_NOOP);
    expectSpawnExit({ ...r, stdout: null }, 0);
    expect(run.labels()).toEqual(["jig:converged"]);
    const comments: Array<{ body: string }> = JSON.parse(
      readFileSync(join(run.bin, "comments-at-converged.json"), "utf8"),
    );
    const ledger = comments
      .map(({ body }) => parseLedger(body))
      .findLast((comment) => comment?.kind === "ledger");
    expect(ledger?.ledger.driver.state).toBe("running");
    expect(ledger?.ledger.phase).toBe(CONVERGED_CI_PHASE);
    // The head's CI, read again after the write, is still green.
    expect(r.stderr).toContain("converged CI: the converged label stands");
    expect(run.edits()).toEqual([
      { add: ["jig:driving"], remove: ["jig:stale"] },
      { add: ["jig:converged"], remove: ["jig:driving"] },
    ]);
  });

  it("leaves the labels when the head moved past the head it verified", async () => {
    const run = labelled({ threads: [] }, []);
    // The label read sees a head the drive did not verify: a push since, or a stale written by a workflow.
    writeFileSync(
      join(run.bin, "head"),
      "7bd2ca906c111111111111111111111111111111",
    );
    const r = await drive(run, PASS_NOOP);
    expectSpawnExit({ ...r, stdout: null }, 0);
    expect(run.labels()).toEqual(["jig:driving"]);
    expect(r.stderr).toContain(
      "labels: PR #999's labels are left as they are: its head 7bd2ca906c111111111111111111111111111111 is not the head",
    );
  });

  it("parks a converged stop whose CI its own label write left red", async () => {
    const run = labelled({ threads: [] }, ["jig:stale"]);
    // The converged label's write starts CI that a commit status reports failing.
    writeFileSync(
      join(run.bin, "status-after-converged.json"),
      JSON.stringify({
        state: "failure",
        statuses: [
          { context: "ci/legacy", state: "failure", description: "failed" },
        ],
      }),
    );
    const r = await drive(run, PASS_NOOP);
    expectSpawnExit({ ...r, stdout: null }, 8);
    expect(r.stderr).toContain(
      "converged CI: parking: commit status ci/legacy failed on head",
    );
    expect(run.edits()).toEqual([
      { add: ["jig:driving"], remove: ["jig:stale"] },
      { add: ["jig:converged"], remove: ["jig:driving"] },
      { add: ["jig:parked"], remove: ["jig:converged"] },
    ]);
    const parked = readState(run.stateDir, "999")?.parked as
      | Array<{ key: string }>
      | undefined;
    expect(parked?.map((p) => p.key)).toEqual(["converged-ci"]);
  });

  for (const successfulPolls of [0, 1]) {
    it(`records the forge reset after ${successfulPolls} successful CI watch polls`, async () => {
      const run = labelled({ threads: [] }, ["jig:stale"]);
      writeFileSync(
        join(run.bin, "limit-watch-after"),
        String(successfulPolls),
      );
      writeFileSync(
        join(run.bin, "status-after-converged.json"),
        JSON.stringify({
          state: "pending",
          statuses: [{ context: "ci/legacy", state: "pending" }],
        }),
      );
      const before = currentMs();
      const r = await drive(run, PASS_NOOP, [], {
        ...LEDGER_ON,
        DRIVE_PR_RATE_LIMIT_WAIT: "0",
      });
      expectSpawnExit({ ...r, stdout: null }, DRIVE_EXIT.FORGE_RATE_LIMITED);
      const state = readState(run.stateDir, "999");
      const events = state?.events as DriveEvent[];
      const stop = events.findLast(({ kind }) => kind === "stop");
      expect(stop?.cause).toBe(String(DRIVE_EXIT.FORGE_RATE_LIMITED));
      expect(parseMs(stop ? (stopInstant(stop) ?? "") : "")).toBeGreaterThan(
        before,
      );
      expect(state?.parked).toEqual([]);
      expect(readFileSync(join(run.bin, "watch-reads"), "utf8")).toBe(
        String(successfulPolls + 1),
      );
    });
  }

  it("reads CI again after a forge reset within the wait bound", async () => {
    const run = labelled({ threads: [] }, ["jig:stale"]);
    writeFileSync(join(run.bin, "short-ci-limit"), "");
    const r = await drive(run, PASS_NOOP, [], {
      ...LEDGER_ON,
      DRIVE_PR_RATE_LIMIT_WAIT: "10",
      JIG_FORGE_BUDGET: "on",
      GH_TOKEN: "test-converged-ci-token",
      XDG_STATE_HOME: run.dir,
    });
    expectSpawnExit({ ...r, stdout: null }, DRIVE_EXIT.CONVERGED);
    expect(r.stderr).toContain("for the reset");
    expect(r.stderr).toContain("converged CI: the converged label stands");
    expect(readState(run.stateDir, "999")?.parked).toEqual([]);
  }, 90_000);

  it("records the forge's explicit reset after a converged-CI read", async () => {
    const run = labelled({ threads: [] }, ["jig:stale"]);
    writeFileSync(join(run.bin, "explicit-ci-limit"), "");
    const before = currentMs();
    const r = await drive(run, PASS_NOOP, [], {
      ...LEDGER_ON,
      DRIVE_PR_RATE_LIMIT_WAIT: "0",
      JIG_FORGE_BUDGET: "on",
      GH_TOKEN: "test-converged-ci-token",
      XDG_STATE_HOME: run.dir,
    });
    expectSpawnExit({ ...r, stdout: null }, DRIVE_EXIT.FORGE_RATE_LIMITED);
    const events = readState(run.stateDir, "999")?.events as DriveEvent[];
    const stop = events.findLast(({ kind }) => kind === "stop");
    expect(stop?.cause).toBe(String(DRIVE_EXIT.FORGE_RATE_LIMITED));
    // The fixture writes the reset it sent; the stop records exactly it.
    const sent = Number(
      readFileSync(join(run.bin, "explicit-ci-reset"), "utf8"),
    );
    expect(sent * 1000).toBeGreaterThan(before + 24 * 60 * 60 * 1000 - 60_000);
    expect(parseMs(stopInstant(stop) ?? "")).toBe(sent * 1000);
  }, 90_000);

  it("records the reset when the stopped-ledger helper's comment read is rate-limited", async () => {
    const run = labelled({ threads: [] }, ["jig:stale"]);
    writeFileSync(join(run.bin, "limit-stopped-ledger-read"), "");
    const before = currentMs();
    const r = await drive(run, PASS_NOOP, [], {
      ...LEDGER_ON,
      DRIVE_PR_RATE_LIMIT_WAIT: "0",
    });
    expectSpawnExit({ ...r, stdout: null }, DRIVE_EXIT.FORGE_RATE_LIMITED);
    const events = readState(run.stateDir, "999")?.events as DriveEvent[];
    const stop = events.findLast(({ kind }) => kind === "stop");
    expect(stop?.cause).toBe(String(DRIVE_EXIT.FORGE_RATE_LIMITED));
    expect(parseMs(stop ? (stopInstant(stop) ?? "") : "")).toBeGreaterThan(
      before,
    );
  });

  it("replaces the state label with parked when it parks", async () => {
    const run = labelled(
      { threads: [{ id: "PRRT_parked", path: "a.ts", bot: true }] },
      ["jig:converged"],
    );
    await park(run.stateDir, "PRRT_parked", "thread");
    const r = await drive(run, PASS_NOOP);
    expectSpawnExit({ ...r, stdout: null }, 8);
    expect(run.labels()).toEqual(["jig:parked"]);
  });

  it("returns indeterminate when the converged label write is refused", async () => {
    const run = labelled({ threads: [] }, []);
    writeFileSync(join(run.bin, "edit-refused"), "");
    const r = await drive(run, PASS_NOOP);
    expectSpawnExit({ ...r, stdout: null }, DRIVE_EXIT.INDETERMINATE);
    expect(r.stderr).toContain(
      "labels: PR #999's state label could not be written",
    );
    expect(r.stderr).toContain(
      "retrying the converged label requires a new drive to watch its CI",
    );
    // The arm and provisional label were both attempted.
    expect(run.edits().length).toBeGreaterThanOrEqual(2);
    expect(run.labels()).toEqual([]);
  });

  it("returns indeterminate when the converged label operation is unavailable", async () => {
    const run = labelled({ threads: [] }, []);
    writeFileSync(join(run.bin, "malformed-label-read-after-first"), "");
    const r = await drive(run, PASS_NOOP);
    expectSpawnExit({ ...r, stdout: null }, DRIVE_EXIT.INDETERMINATE);
    expect(r.stderr).toContain(
      "retrying the converged label requires a new drive to watch its CI",
    );
    expect(run.labels()).not.toContain("jig:converged");
    expect(driverRecordRow(run.stateDir, "999")?.released).toBe(1);
  });

  for (const stand of ["jig:hold", "jig:held"])
    it(`writes no label on a pull request carrying ${stand}`, async () => {
      const run = labelled({ threads: [] }, [stand, "jig:stale"]);
      const r = await drive(run, PASS_NOOP);
      expectSpawnExit({ ...r, stdout: null }, DRIVE_EXIT.CONVERGED);
      expect(run.edits()).toEqual([]);
      expect(run.labels()).toEqual([stand, "jig:stale"]);
      expect(r.stderr).toContain(`it carries ${stand}`);
    });

  it("reads and writes no label while dispatch.labels is off on the default branch, whatever the checkout says", async () => {
    const run = labelled({ threads: [] }, ["jig:stale"]);
    writeFileSync(
      join(run.bin, "jig.yaml"),
      "dispatch:\n  stalled_after: 30m\n",
    );
    const r = await drive(run, PASS_NOOP, [], {
      ...LEDGER_ON,
      // A checkout's own layer turning them on does not count.
      JIG__DISPATCH__LABELS__ENABLED: "true",
    });
    expectSpawnExit({ ...r, stdout: null }, 0);
    expect(run.edits()).toEqual([]);
    expect(r.stderr).not.toContain("labels: ");
  });
});
