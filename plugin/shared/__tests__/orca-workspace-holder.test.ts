/**
 * holder.ts, through `openBranch`: a checkout Orca does not list that holds
 * the branch asked for. Git runs for real on a clone with an origin; Orca is
 * a fake that lists the worktrees it created and creates one as `git
 * worktree add` would, on a branch of its own.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { OrcaEnvelope } from "../orca-workspace/envelope.ts";
import { BusyHolderError } from "../orca-workspace/holder.ts";
import { openBranch } from "../orca-workspace/open.ts";
import { boundedHook, type OpenPort } from "../orca-workspace/port.ts";
import { localContext } from "../orca-workspace/runner.ts";
import type { TreeDrivers } from "../idle-holder.ts";
import { BRANCH, ENV, git, heldTree } from "./holder-fixture.ts";

const RID = "rid";

/** A port on this machine whose Orca lists only the worktrees it created. */
function portOf(
  root: string,
  clone: string,
  drivers: TreeDrivers | undefined,
): { port: OpenPort; lines: string[]; orca: string[][] } {
  const lines: string[] = [];
  const orca: string[][] = [];
  const created: { id: string; path: string; branch: string }[] = [];
  const port: OpenPort = {
    host: localContext((line) => lines.push(line)),
    runHook: boundedHook,
    orcaCall<T>(args: string[]): OrcaEnvelope<T> {
      orca.push(args);
      if (args[0] === "worktree" && args[1] === "list")
        return { ok: true, result: { worktrees: created } as T };
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
        return { ok: true, result: { worktree: row } as T };
      }
      return { ok: false, error: { code: "unhandled" } };
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

  test("refuses every such checkout, with how to show it, when the port cannot read what drives a tree", () => {
    const { root, clone, holder } = heldTree();
    const { port } = portOf(root, clone, undefined);
    expect(() => open(port, clone)).toThrow(
      `${BRANCH} is checked out at ${holder}, which Orca does not list; show the repository's non-Orca worktrees`,
    );
    expect(symbolic(holder)).toBe(BRANCH);
  });
});
