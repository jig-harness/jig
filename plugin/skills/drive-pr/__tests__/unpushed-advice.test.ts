/**
 * The advice for counting a stopped pass's unpushed commits names a range that
 * exists: the driven branch's remote ref once an attach named it; else, with
 * the attach off, the sources the leftovers probe reads (the upstream, then the
 * tree's attach record); else the check to make by hand, never `@{u}` where
 * the tree has none.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { type Clone, makeClone } from "./attach-pr-fixtures.ts";

const DRIVEN_BRANCH = join(
  import.meta.dir,
  "..",
  "scripts",
  "lib",
  "driven-branch.ts",
);
const PROC = join(import.meta.dir, "..", "scripts", "lib", "proc.ts");
const BY_HAND = "git log HEAD --branches --not --remotes";
const SPAWN_TIMEOUT_MS = 120_000;

const clones: Clone[] = [];
afterAll(() => {
  for (const c of clones) rmSync(c.root, { recursive: true, force: true });
});
function fresh(): Clone {
  const c = makeClone();
  clones.push(c);
  return c;
}

/**
 * The advice for the tree at `root`, from a process of its own: the driven
 * remote ref is module state an attach sets, and must not reach other tests.
 */
function advice(c: Clone, root: string, attached?: string): string {
  const code = `
    import { setDrivenRemoteRef, unpushedCountAdvice } from ${JSON.stringify(DRIVEN_BRANCH)};
    import { git } from ${JSON.stringify(PROC)};
    ${attached === undefined ? "" : `setDrivenRemoteRef("origin", ${JSON.stringify(attached)});`}
    console.log(await unpushedCountAdvice(git, ${JSON.stringify(root)}, { timeoutSec: 60 }));
  `;
  const r = Bun.spawnSync([process.execPath, "-e", code], {
    cwd: root,
    env: { ...c.env, DRIVE_PR_ATTACH: "off" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: SPAWN_TIMEOUT_MS,
  });
  expectSpawnExit(
    {
      exitCode: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    },
    0,
    "unpushedCountAdvice",
  );
  return r.stdout.toString().trim();
}

describe("unpushedCountAdvice with the attach off", () => {
  test("counts against the upstream when the branch has one", () => {
    const c = fresh();
    expect(advice(c, c.primary)).toBe("`git rev-list --count '@{u}..HEAD'`");
  });

  test("names no range for a branch with no upstream", () => {
    const c = fresh();
    c.git(c.primary, "switch", "-q", "-c", "scratch");
    const text = advice(c, c.primary);
    expect(text).not.toContain("@{u}");
    expect(text).not.toContain("rev-list");
    expect(text).toContain(BY_HAND);
    expect(text).toContain("no range can be named");
  });

  test("names no range for a detached tree no attach prepared", () => {
    const c = fresh();
    const text = advice(c, c.tree("wt1"));
    expect(text).not.toContain("@{u}");
    expect(text).toContain(BY_HAND);
  });

  test("the by-hand check finds a commit a detached tree holds on no branch", () => {
    const c = fresh();
    const tree = c.tree("wt1");
    const stranded = c.commit(tree, "stranded.txt");
    const [, ...args] = BY_HAND.split(" ");
    expect(c.git(tree, ...args, "--format=%H")).toBe(stranded);
  });

  test("counts against the attach record's remote ref for a detached tree", () => {
    const c = fresh();
    c.git(c.tree("holder"), "switch", "-q", "feature");
    const tree = c.tree("wt1");
    expectSpawnExit(c.attach(tree, "42"), 0, "attach");
    expect(advice(c, tree)).toBe(
      "`git rev-list --count refs/remotes/origin/feature..HEAD`",
    );
  });
});

describe("unpushedCountAdvice with the attach on", () => {
  test("counts against the driven branch's remote ref, as before", () => {
    const c = fresh();
    c.git(c.primary, "switch", "-q", "-c", "scratch");
    expect(advice(c, c.primary, "feature")).toBe(
      "`git rev-list --count refs/remotes/origin/feature..HEAD`",
    );
  });
});
