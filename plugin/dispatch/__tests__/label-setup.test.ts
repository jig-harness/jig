/**
 * `jig dispatch labels`: the one-time setup of the pull request state labels,
 * for a repository that drives pull requests without the dispatcher. It needs
 * no machine file and installs no job; it says which labels it created and
 * which a person must create.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { SLUG, type World, world } from "./fixtures.ts";

const ON = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  labels: { enabled: true }
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A world with the labels on and no machine file. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(ON);
  writeFileSync(
    join(w.dir, "labels-repo.json"),
    JSON.stringify(["jig:driving", "bug"]),
  );
  return w;
}

const repoLabels = (w: World): string[] =>
  (
    JSON.parse(readFileSync(join(w.dir, "labels-repo.json"), "utf8")) as Array<
      string | { name: string }
    >
  )
    .map((l) => (typeof l === "string" ? l : l.name))
    .sort();

describe("jig dispatch labels", () => {
  it("creates the labels the repository lacks, with no machine file and no job", async () => {
    const w = fixture();
    const preview = await w.dispatch(["labels"]);
    expectSpawnExit(preview, 0);
    expect(preview.stdout).toContain("jig:converged");
    expect(repoLabels(w)).toEqual(["bug", "jig:driving"]);

    const made = await w.dispatch(["labels", "--repo", w.repo, "--yes"]);
    expectSpawnExit(made, 0);
    expect(made.stdout).toContain(`${SLUG}: created jig:converged`);
    expect(made.stdout).toContain(`${SLUG}: created jig:followup-failed`);
    expect(made.stdout).toContain(`${SLUG}: created manual-ops`);
    expect(made.stdout).toContain(`${SLUG}: created automation`);
    expect(made.stdout).not.toContain("created jig:driving");
    expect(repoLabels(w)).toContain("jig:hold");
    // Nothing of the dispatcher was installed: no machine file, no job.
    expect(made.stdout).not.toContain("--apply");
    expect(existsSync(join(w.home, ".jig", "dispatch.yaml"))).toBe(false);
  }, 60_000);

  it("lists the labels a person must create, each with its command, when the account may not", async () => {
    const w = fixture();
    writeFileSync(join(w.dir, "label-create-fail"), "");
    const refused = await w.dispatch(["labels", "--yes"]);
    expectSpawnExit(refused, 1);
    expect(refused.stdout).toContain(
      "these labels could not be created with the signed-in account; a person who may create labels runs:",
    );
    expect(refused.stdout).toContain(
      `gh label create 'jig:converged' --repo ${SLUG}`,
    );
    rmSync(join(w.dir, "label-create-fail"));
    expectSpawnExit(await w.dispatch(["labels", "--yes"]), 0);
    const again = await w.dispatch(["labels"]);
    expectSpawnExit(again, 0);
    expect(again.stdout).toContain("exists");
  }, 60_000);
});
