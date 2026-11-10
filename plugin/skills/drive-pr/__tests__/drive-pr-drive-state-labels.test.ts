/**
 * drive-pr suite: the drive's own pull request state label. With
 * `dispatch.labels` on and no dispatcher anywhere, a drive writes `driving`
 * (removing the `drive` command) once its running ledger is out and before
 * its first round, `converged` when it stops `CONVERGED` and `parked` when it
 * parks, each replacing the state label before it; a refused write is
 * reported and changes no exit; a pull request carrying `hold` or `held` is
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

  it("reports a refused write and stops with the exit it would have had", async () => {
    const run = labelled({ threads: [] }, []);
    writeFileSync(join(run.bin, "edit-refused"), "");
    const r = await drive(run, PASS_NOOP);
    expectSpawnExit({ ...r, stdout: null }, 0);
    expect(r.stderr).toContain(
      "labels: PR #999's state label could not be written",
    );
    expect(r.stderr).toContain(
      "a dispatcher's next tick corrects it where one runs",
    );
    // Both moments tried, and neither stopped the drive.
    expect(run.edits()).toHaveLength(2);
    expect(run.labels()).toEqual([]);
  });

  for (const stand of ["jig:hold", "jig:held"])
    it(`writes no label on a pull request carrying ${stand}`, async () => {
      const run = labelled({ threads: [] }, [stand, "jig:stale"]);
      const r = await drive(run, PASS_NOOP);
      expectSpawnExit({ ...r, stdout: null }, 0);
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
