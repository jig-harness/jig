/**
 * holder.ts, through `openBranch`: a checkout Orca does not list that holds
 * the branch asked for. Git runs for real on a clone with an origin; Orca is
 * a fake that lists the worktrees it created and creates one as `git
 * worktree add` would, on a branch of its own.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { OrcaError } from "../orca-workspace/envelope.ts";
import {
  BusyHolderError,
  type HolderPolicy,
  RESCUE_PREFIX,
  rescueBranchName,
  waived,
} from "../orca-workspace/holder.ts";
import { openBranch } from "../orca-workspace/open.ts";
import {
  boundedHook,
  type OpenPort,
  type OrcaAnswer,
} from "../orca-workspace/port.ts";
import { ok } from "../outcome.ts";
import { type Context, localContext } from "../orca-workspace/runner.ts";
import type { HolderReasonKind, TreeDrivers } from "../idle-holder.ts";
import { BRANCH, ENV, git, heldTree } from "./holder-fixture.ts";

const RID = "rid";

/** A port on this machine whose Orca lists only the worktrees it created. */
function portOf(
  root: string,
  clone: string,
  drivers: TreeDrivers | undefined,
  host: (ctx: Context) => Context = (ctx) => ctx,
): { port: OpenPort; lines: string[]; orca: string[][] } {
  const lines: string[] = [];
  const orca: string[][] = [];
  const created: { id: string; path: string; branch: string }[] = [];
  const port: OpenPort = {
    host: host(localContext((line) => lines.push(line))),
    runHook: boundedHook,
    orcaCall<T>(args: string[]): OrcaAnswer<T> {
      orca.push(args);
      if (args[0] === "worktree" && args[1] === "list")
        return ok({ ok: true, result: { worktrees: created } as T });
      if (args[0] === "worktree" && args[1] === "create") {
        const base = args[args.indexOf("--base-branch") + 1] ?? "";
        const path = join(root, "orca-ws");
        git(clone, "worktree", "add", "-q", "-b", "orca/ws", path, base);
        const row = {
          id: `${RID}::${path}`,
          path,
          branch: "refs/heads/orca/ws",
        };
        created.push(row);
        return ok({ ok: true, result: { worktree: row } as T });
      }
      return ok({ ok: false, error: { code: "unhandled" } });
    },
    where: "",
    ...(drivers === undefined ? {} : { drivers }),
  };
  return { port, lines, orca };
}

const open = (port: OpenPort, clone: string) =>
  openBranch(port, {
    repo: { id: RID, path: clone },
    branch: BRANCH,
    createHook: false,
  });

const symbolic = (path: string): string | null => {
  const r = Bun.spawnSync(
    ["git", "-C", path, "symbolic-ref", "-q", "--short", "HEAD"],
    {
      env: ENV,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};

describe("openBranch with a checkout Orca does not list holding the branch", () => {
  test("detaches an idle one at its commit and opens a new worktree on the branch", () => {
    const { root, clone, holder } = heldTree();
    const head = git(holder, "rev-parse", "HEAD");
    const { port, lines } = portOf(root, clone, () => []);
    const opened = open(port, clone);
    expect(opened.reattached).toBe(false);
    expect(opened.worktree).toMatchObject({
      path: join(root, "orca-ws"),
      branch: BRANCH,
    });
    expect(symbolic(opened.worktree.path)).toBe(BRANCH);
    expect(git(opened.worktree.path, "rev-parse", "HEAD")).toBe(head);
    expect(symbolic(holder)).toBeNull();
    expect(git(holder, "rev-parse", "HEAD")).toBe(head);
    expect(lines).toContain(
      `↺ detached the idle checkout at ${holder} from ${BRANCH} (at ${head.slice(0, 12)})`,
    );
  });

  test("refuses a busy one, naming it and what keeps it busy, and leaves it holding the branch", () => {
    const { root, clone, holder } = heldTree();
    writeFileSync(join(holder, "draft.txt"), "draft\n");
    const { port, orca } = portOf(root, clone, () => [
      "a live driver of PR #7 holds it",
    ]);
    let thrown: unknown = null;
    try {
      open(port, clone);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BusyHolderError);
    expect(thrown).toMatchObject({
      path: holder,
      branch: BRANCH,
      reasons: [
        "it has uncommitted or untracked changes",
        "a live driver of PR #7 holds it",
      ],
    });
    expect(symbolic(holder)).toBe(BRANCH);
    expect(orca.some((args) => args[1] === "create")).toBe(false);
  });

  test("leaves a holder that switched to another branch at the same commit after the check", () => {
    const { root, clone, holder } = heldTree();
    let symbolicReads = 0;
    const { port } = portOf(
      root,
      clone,
      () => [],
      (ctx) => ({
        ...ctx,
        run: (argv, options) => {
          // The idle check reads the branch first; the detach reads it again.
          if (argv.includes("symbolic-ref") && ++symbolicReads === 2)
            git(holder, "switch", "-q", "-c", "other");
          return ctx.run(argv, options);
        },
      }),
    );
    expect(() => open(port, clone)).toThrow(BusyHolderError);
    expect(symbolic(holder)).toBe("other");
    expect(git(holder, "branch", "--list", "other")).toContain("other");
  });

  test("leaves a holder whose head moved after the check, and refuses it as busy", () => {
    const { root, clone, holder } = heldTree();
    const head = git(holder, "rev-parse", "HEAD");
    // A commit lands in the holder between the idle check and the detach.
    const { port, orca } = portOf(
      root,
      clone,
      () => [],
      (ctx) => ({
        ...ctx,
        run: (argv, options) => {
          if (argv.includes("update-ref"))
            git(holder, "commit", "-q", "--allow-empty", "-m", "late work");
          return ctx.run(argv, options);
        },
      }),
    );
    let thrown: unknown = null;
    try {
      open(port, clone);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BusyHolderError);
    expect(thrown).toMatchObject({
      reasons: ["its head moved during the check"],
    });
    expect(symbolic(holder)).toBe(BRANCH);
    expect(git(holder, "rev-parse", "HEAD~1")).toBe(head);
    expect(orca.some((args) => args[1] === "create")).toBe(false);
  });

  test("refuses as an ordinary failure, not a busy holder, when the check runs out of time", () => {
    const { root, clone, holder } = heldTree();
    const { port } = portOf(
      root,
      clone,
      () => [],
      (ctx) => ({
        ...ctx,
        budget: () => 1,
      }),
    );
    let thrown: unknown = null;
    try {
      open(port, clone);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OrcaError);
    expect(thrown).not.toBeInstanceOf(BusyHolderError);
    expect(String(thrown)).toContain("ran out of time");
    expect(symbolic(holder)).toBe(BRANCH);
  });

  test("refuses every such checkout, with how to show it, when the port cannot read what drives a tree", () => {
    const { root, clone, holder } = heldTree();
    const { port } = portOf(root, clone, undefined);
    expect(() => open(port, clone)).toThrow(
      `${BRANCH} is checked out at ${holder}, which Orca does not list; show the repository's non-Orca worktrees`,
    );
    expect(symbolic(holder)).toBe(BRANCH);
  });
});

/** The port of `portOf`, with the host's holder policy. */
function withPolicy(
  root: string,
  clone: string,
  holders: HolderPolicy,
  drivers: TreeDrivers = () => [],
  host?: (ctx: Context) => Context,
) {
  const made = portOf(root, clone, drivers, host);
  made.port.holders = holders;
  return made;
}

const DETACH: HolderPolicy = { detachIdle: true, rescueUnpushed: false };
const RESCUE: HolderPolicy = { detachIdle: true, rescueUnpushed: true };

/** The local branches of `clone` under the rescue prefix. */
const rescues = (clone: string): string[] =>
  git(
    clone,
    "branch",
    "--list",
    "--format=%(refname:short)",
    `${RESCUE_PREFIX}*`,
  )
    .split("\n")
    .filter(Boolean);

/** A holder with one commit, `local work`, that origin's copy of the branch lacks. */
function unpushedTree() {
  const tree = heldTree();
  const pushed = git(tree.holder, "rev-parse", "HEAD");
  writeFileSync(join(tree.holder, "file.txt"), "local\n");
  git(tree.holder, "commit", "-q", "-am", "local work");
  return { ...tree, pushed, head: git(tree.holder, "rev-parse", "HEAD") };
}

describe("openBranch with the host's holder policy", () => {
  test("detach_idle_holders detaches an unused holder whose every commit is pushed, its changes left in its tree", () => {
    const { root, clone, holder } = heldTree();
    writeFileSync(join(holder, "draft.txt"), "draft\n");
    const head = git(holder, "rev-parse", "HEAD");
    const { port } = withPolicy(root, clone, DETACH);
    const opened = open(port, clone);
    expect(opened.detached).toEqual({ path: holder, branch: BRANCH, head });
    expect(symbolic(opened.worktree.path)).toBe(BRANCH);
    expect(symbolic(holder)).toBeNull();
    expect(git(holder, "status", "--porcelain")).toBe("?? draft.txt");
    expect(rescues(clone)).toEqual([]);
  });

  test("without the policy the same holder is refused as busy and left holding the branch", () => {
    const { root, clone, holder } = heldTree();
    writeFileSync(join(holder, "draft.txt"), "draft\n");
    const { port } = portOf(root, clone, () => []);
    expect(() => open(port, clone)).toThrow(BusyHolderError);
    expect(symbolic(holder)).toBe(BRANCH);
  });

  test("detach_idle_holders alone leaves a holder with unpushed commits to a person", () => {
    const { root, clone, holder, head } = unpushedTree();
    const { port } = withPolicy(root, clone, DETACH);
    expect(() => open(port, clone)).toThrow(BusyHolderError);
    expect(symbolic(holder)).toBe(BRANCH);
    expect(git(holder, "rev-parse", "HEAD")).toBe(head);
    expect(rescues(clone)).toEqual([]);
  });

  test("rescue_unpushed keeps the unpushed commits on a rescue branch before the detach, and pushes nothing", () => {
    const { root, clone, holder, pushed, head } = unpushedTree();
    const { port, lines } = withPolicy(root, clone, RESCUE);
    const opened = open(port, clone);
    const [rescue] = rescues(clone);
    expect(rescue).toStartWith(RESCUE_PREFIX);
    expect(opened.detached).toEqual({
      path: holder,
      branch: BRANCH,
      head,
      rescue: { branch: rescue as string, clone },
    });
    expect(git(clone, "rev-parse", `refs/heads/${rescue}`)).toBe(head);
    expect(symbolic(holder)).toBeNull();
    expect(git(holder, "rev-parse", "HEAD")).toBe(head);
    // The branch is back at origin's copy, so the new worktree opens on it.
    expect(git(opened.worktree.path, "rev-parse", "HEAD")).toBe(pushed);
    expect(
      git(clone, "ls-remote", "origin", `refs/heads/${BRANCH}`),
    ).toStartWith(pushed);
    expect(
      git(clone, "ls-remote", "origin", `refs/heads/${RESCUE_PREFIX}*`),
    ).toBe("");
    expect(lines.join("\n")).toContain(
      `its unpushed commits kept on ${rescue} in ${clone}`,
    );
  });

  test("a rescue that fails leaves the tree as it is and refuses the holder as busy", () => {
    const { root, clone, holder, head } = unpushedTree();
    const { port } = withPolicy(
      root,
      clone,
      RESCUE,
      () => [],
      (ctx) => ({
        ...ctx,
        run: (argv, options) =>
          argv.some((a) => a.startsWith(`refs/heads/${RESCUE_PREFIX}`)) &&
          argv.includes("update-ref")
            ? { status: 1, stdout: "", stderr: "fatal: cannot lock ref" }
            : ctx.run(argv, options),
      }),
    );
    let thrown: unknown = null;
    try {
      open(port, clone);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BusyHolderError);
    expect((thrown as BusyHolderError).reasons.at(-1)).toContain(
      "its unpushed commits could not be kept on a rescue branch, so it was left as it is",
    );
    expect(symbolic(holder)).toBe(BRANCH);
    expect(git(holder, "rev-parse", "HEAD")).toBe(head);
    expect(git(clone, "rev-parse", `refs/heads/${BRANCH}`)).toBe(head);
    expect(rescues(clone)).toEqual([]);
  });

  test("a rescue branch whose readback fails is removed and the holder is left as it is", () => {
    const { root, clone, holder, head } = unpushedTree();
    const { port } = withPolicy(
      root,
      clone,
      RESCUE,
      () => [],
      (ctx) => ({
        ...ctx,
        run: (argv, options) =>
          argv.includes("rev-parse") &&
          argv.some((a) => a.startsWith(`refs/heads/${RESCUE_PREFIX}`))
            ? { status: 1, stdout: "", stderr: "" }
            : ctx.run(argv, options),
      }),
    );
    expect(() => open(port, clone)).toThrow(BusyHolderError);
    expect(symbolic(holder)).toBe(BRANCH);
    expect(git(holder, "rev-parse", "HEAD")).toBe(head);
    expect(rescues(clone)).toEqual([]);
  });

  test("a detach that fails after the rescue removes the rescue branch it no longer needs", () => {
    const { root, clone, holder, head } = unpushedTree();
    const { port } = withPolicy(
      root,
      clone,
      RESCUE,
      () => [],
      (ctx) => ({
        ...ctx,
        run: (argv, options) =>
          argv.includes("update-ref") && argv.includes("HEAD")
            ? { status: 1, stdout: "", stderr: "fatal: cannot lock ref 'HEAD'" }
            : ctx.run(argv, options),
      }),
    );
    expect(() => open(port, clone)).toThrow("could not detach the checkout");
    expect(symbolic(holder)).toBe(BRANCH);
    expect(git(clone, "rev-parse", `refs/heads/${BRANCH}`)).toBe(head);
    expect(rescues(clone)).toEqual([]);
  });

  test("a busy holder is never touched, whatever the policy", () => {
    const { root, clone, holder, head } = unpushedTree();
    writeFileSync(join(holder, "draft.txt"), "draft\n");
    const { port } = withPolicy(root, clone, RESCUE, () => [
      "a live session lease holds it",
    ]);
    expect(() => open(port, clone)).toThrow(BusyHolderError);
    expect(symbolic(holder)).toBe(BRANCH);
    expect(git(holder, "rev-parse", "HEAD")).toBe(head);
    expect(rescues(clone)).toEqual([]);
  });
});

describe("waived", () => {
  const busy = (kinds: HolderReasonKind[], extra = {}) => ({
    idle: false as const,
    reasons: kinds.map((k) => k),
    kinds,
    head: "a".repeat(40),
    timedOut: false,
    ...extra,
  });

  test("waives only the kinds the policy names, a rescue only for unpushed commits", () => {
    expect(waived(DETACH, busy(["changes"]))).toEqual({
      head: "a".repeat(40),
      rescue: false,
    });
    expect(waived(DETACH, busy(["unpushed"]))).toBeNull();
    expect(waived(RESCUE, busy(["changes", "unpushed"]))).toEqual({
      head: "a".repeat(40),
      rescue: true,
    });
    expect(waived(RESCUE, busy(["changes", "other"]))).toBeNull();
    expect(waived(undefined, busy(["changes"]))).toBeNull();
    expect(
      waived({ detachIdle: false, rescueUnpushed: true }, busy(["unpushed"])),
    ).toBeNull();
  });

  test("never waives a check that ran out of time or read no head", () => {
    expect(waived(RESCUE, busy(["changes"], { timedOut: true }))).toBeNull();
    expect(waived(RESCUE, busy(["changes"], { head: undefined }))).toBeNull();
  });
});

describe("rescueBranchName", () => {
  test("names the tree and the moment, as a valid branch name", () => {
    expect(
      rescueBranchName("/x/agent tree..lock", "2026-11-27T17:05:09.123Z"),
    ).toBe(`${RESCUE_PREFIX}agent-tree-20261127T170509Z`);
    expect(rescueBranchName("/", "2026-11-27T17:05:09.000Z")).toBe(
      `${RESCUE_PREFIX}tree-20261127T170509Z`,
    );
  });
});
