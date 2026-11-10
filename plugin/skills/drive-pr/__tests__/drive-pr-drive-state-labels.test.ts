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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import {
  binDir,
  type Fixture,
  makeScratchRepo,
  park,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { PASS_NOOP, runDriveIn } from "./drive-loop-harness.ts";

useDrivePrSuite();

const LABELS_ON = {
  DRIVE_PR_LEDGER: "on",
  JIG__DISPATCH__LABELS__ENABLED: "true",
};

/**
 * A `gh` that keeps the pull request's labels in `labels.json` beside it,
 * logs each label edit to `edits.log`, refuses one while `edit-refused`
 * exists, and runs the stub forge for everything else.
 */
const LABEL_GH = (stub: string) => `#!/usr/bin/env bun
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const file = path.join(dir, "labels.json");
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
if (args[0] === "pr" && args[1] === "view" && args.at(-2) === "--json" && args.at(-1) === "labels") {
  process.stdout.write(JSON.stringify({ labels: read().map((name) => ({ name })) }));
  process.exit(0);
}
const values = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const add = values("--add-label");
const remove = values("--remove-label");
if (args[0] === "pr" && args[1] === "edit" && [...add, ...remove].some((l) => l.startsWith("jig:"))) {
  fs.appendFileSync(path.join(dir, "edits.log"), JSON.stringify({ add, remove }) + "\\n");
  if (fs.existsSync(path.join(dir, "edit-refused"))) {
    process.stderr.write("could not add label: 'jig:driving' not found\\n");
    process.exit(1);
  }
  fs.writeFileSync(file, JSON.stringify([...read().filter((l) => !remove.includes(l)), ...add]));
  process.exit(0);
}
const child = require("node:child_process").spawnSync(${JSON.stringify(stub)}, args, { stdio: "inherit" });
process.exit(child.status ?? 1);
`;

let seq = 0;

/** A fixture in a tree of its own, its pull request carrying `labels`. */
function labelled(f: Fixture, labels: string[]) {
  const tree = makeScratchRepo(`state-labels-${++seq}`);
  const { dir, stateDir } = writeFixture(
    { reviewedSha: tree.head, head: tree.head, ...f },
    tree.dir,
  );
  const bin = join(dir, "label-bin");
  mkdirSync(bin, { recursive: true });
  writeFakeProgram(join(bin, "gh"), LABEL_GH(join(binDir, "gh")));
  writeFileSync(join(bin, "labels.json"), JSON.stringify(labels));
  return {
    dir,
    stateDir,
    tree: tree.dir,
    bin,
    labels: (): string[] =>
      JSON.parse(readFileSync(join(bin, "labels.json"), "utf8")),
    edits: (): Array<{ add: string[]; remove: string[] }> =>
      existsSync(join(bin, "edits.log"))
        ? readFileSync(join(bin, "edits.log"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
        : [],
  };
}

async function drive(
  run: ReturnType<typeof labelled>,
  pass: string[],
  flags: string[] = [],
  env: Record<string, string> = LABELS_ON,
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
    expect(r.stderr).toContain("the dispatcher's next tick corrects it");
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

  it("reads and writes no label while dispatch.labels is off", async () => {
    const run = labelled({ threads: [] }, ["jig:stale"]);
    const r = await drive(run, PASS_NOOP, [], { DRIVE_PR_LEDGER: "on" });
    expectSpawnExit({ ...r, stdout: null }, 0);
    expect(run.edits()).toEqual([]);
    expect(r.stderr).not.toContain("labels: ");
  });
});
