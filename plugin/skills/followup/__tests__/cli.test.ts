/**
 * The script end to end, in scratch repositories, spawned with the scratch
 * repository as its working directory: a run started from facts, its arms
 * as the repository's configuration leaves them, verdicts recorded, and the
 * settle that refuses an unsettled arm.
 */
import { describe, expect, test } from "bun:test";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { planArms } from "../scripts/lib/arms.ts";
import { startRun } from "../scripts/lib/run.ts";
import { factsOf, repository, runScript } from "./helpers.ts";

/** A scratch repository with a started run of PR 7. */
function started(config = "", mode: "post-merge" | "preview" = "post-merge") {
  const root = repository(config === "" ? {} : { ".config/jig.yaml": config });
  startRun(
    root,
    factsOf({ mode }),
    planArms({ mode, changelog: false, orca: false, off: [] }),
  );
  return root;
}

describe("followup.ts", () => {
  test("record refuses empty evidence", () => {
    const root = started();
    const run = runScript(root, [
      "record",
      "tracker",
      "owed",
      "--evidence",
      "",
    ]);
    expectSpawnExit(run, 2);
    expect(run.stderr).toContain("needs its evidence");
  });

  test("settle refuses done while an arm has no verdict, naming it", () => {
    const root = started();
    const run = runScript(root, ["settle"]);
    expectSpawnExit(run, 1);
    expect(run.stderr).toContain("tracker");
    expect(run.stderr).toContain("no verdict");
  });

  test("a run with every arm recorded settles, with one row per arm", () => {
    const root = started();
    for (const arm of [
      "tracker",
      "deferred-findings",
      "out-of-tree",
      "scaffolding",
      "live-verification",
      "next-step",
    ]) {
      const recorded = runScript(root, [
        "record",
        arm,
        "not-owed",
        "--evidence",
        `${arm}: the fact that settled it`,
      ]);
      expectSpawnExit(recorded, 0, arm);
    }
    const run = runScript(root, ["settle", "--json"]);
    expectSpawnExit(run, 0);
    const settled = JSON.parse(run.stdout) as {
      ending: string;
      rows: { arm: string; verdict: string }[];
    };
    expect(settled.ending).toBe("done");
    expect(settled.rows.find((r) => r.arm === "release")?.verdict).toBe(
      "skipped",
    );
  });

  test("followup.off in the configuration removes the arm", () => {
    const root = started("followup:\n  off: [live-verification, next-step]\n");
    const run = runScript(root, ["arms", "--json"]);
    expectSpawnExit(run, 0);
    const plan = JSON.parse(run.stdout) as {
      apply: string[];
      skipped: { id: string }[];
    };
    expect(plan.apply).not.toContain("live-verification");
    expect(plan.apply).not.toContain("next-step");
    expect(plan.skipped.map((s) => s.id)).toContain("next-step");
  });

  test("a configuration that loosens the authority table is refused", () => {
    const root = started("followup:\n  authority:\n    merge: ask\n");
    const run = runScript(root, ["authority"]);
    expectSpawnExit(run, 2);
    expect(run.stderr).toContain("would loosen it");
  });

  test("guard refuses a preview without asking the marker", () => {
    const root = started("", "preview");
    const run = runScript(root, ["guard", "7", "--comment", "42"]);
    expectSpawnExit(run, 4);
    expect(run.stderr).toContain("carries out nothing");
  });
});
