/**
 * The proof that a workspace a launch did not open is still its pull
 * request's checkout (`runtime/orca-pr-workspace.ts`), over real git
 * repositories: the forge's answer and origin's address are the fixture's,
 * every other git call is real.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  type Context,
  localRunner,
} from "../../shared/orca-workspace/runner.ts";
import { proveWorkspace } from "../lib/runtime/orca-pr-workspace.ts";
import { workspaceHeadReader } from "../lib/runtime/orca-workspace-head.ts";
import {
  guarded,
  holdUnanswered,
  stopHolding,
} from "../../shared/outbound/hold.ts";
import { outboundFailure } from "../../shared/outbound/failure.ts";
import { heldRun } from "../../shared/proc.ts";
import { traceGhRunner } from "../../shared/trace.ts";

const BRANCH = "feature/7";
const FORGE = "https://github.com/example-org/example-repo.git";
const ELSEWHERE = "https://github.com/example-org/other-repo.git";

const roots: string[] = [];
afterEach(() => {
  stopHolding();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function git(...args: string[]): string {
  const r = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(r, 0, `git ${args.join(" ")}`);
  return r.stdout.toString().trim();
}

/** An origin, a clone of it whose `BRANCH` is the pull request's head, and a worktree of the clone on it. */
function repos(): { origin: string; clone: string; ws: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "pr-workspace-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  const ws = join(root, "ws");
  git("init", "-q", "-b", "main", clone);
  writeFileSync(join(clone, "README.md"), "base\n");
  git("-C", clone, "add", "README.md");
  git("-C", clone, "commit", "-q", "-m", "base");
  git("-C", clone, "branch", BRANCH);
  git("-C", clone, "checkout", "-q", BRANCH);
  writeFileSync(join(clone, "change.txt"), "head\n");
  git("-C", clone, "add", "change.txt");
  git("-C", clone, "commit", "-q", "-m", "head");
  git("-C", clone, "checkout", "-q", "main");
  git("clone", "-q", "--bare", clone, origin);
  git("-C", clone, "remote", "add", "origin", origin);
  git("-C", clone, "fetch", "-q", "origin");
  git("-C", clone, "worktree", "add", "-q", ws, BRANCH);
  return { origin, clone, ws, head: git("-C", ws, "rev-parse", "HEAD") };
}

/** Real git, with the forge's answer for PR #7 at origin's `BRANCH` and origin's address shown as `url`. */
function context(origin: string, url = FORGE, movedHead = false): Context {
  return {
    stateDir: "/state",
    log() {
      /* The fixture does not display progress. */
    },
    sleep() {
      /* The fixture has no retry delay. */
    },
    run(argv, options) {
      if (argv[0] === "gh")
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            state: "OPEN",
            headRefName: BRANCH,
            headRefOid: git("-C", origin, "rev-parse", BRANCH),
            isCrossRepository: false,
            headRepositoryOwner: { login: "example-org" },
            headRepository: { name: movedHead ? "other-repo" : "example-repo" },
            url: "https://github.com/example-org/example-repo/pull/7",
          }),
        };
      if (argv.includes("get-url")) {
        const real = localRunner(argv, options);
        return real.status === 0 ? { ...real, stdout: `${url}\n` } : real;
      }
      return localRunner(argv, options);
    },
  };
}

const prove = (r: ReturnType<typeof repos>, url?: string, ws = r.ws) =>
  proveWorkspace(
    context(r.origin, url),
    r.clone,
    ws,
    7,
    BRANCH,
    "example-org/example-repo",
  );

describe("a workspace's proof against its pull request's head", () => {
  it("sends no verification request to a forge already held in this run", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-held-forge-"));
    roots.push(root);
    holdUnanswered(join(root, "holds.json"));
    await guarded(
      "github",
      async () => false,
      () => outboundFailure("unreachable", "offline"),
      () => false,
    );
    let sent = 0;
    const send = traceGhRunner(
      async () => {
        sent += 1;
        return heldRun(outboundFailure("invalid", "unexpected request"));
      },
      () => 120,
      {},
      heldRun,
    );
    const read = workspaceHeadReader(context("unused"), send);
    const result = await read(["gh", "pr", "view", "7"], { cwd: root });
    expect(sent).toBe(0);
    expect(result.stderr).toContain("[unreachable]");
    expect(result.stderr).toContain("not asked again");
  });

  it("tightens the forge deadline to the workspace remainder and sends nothing below the transport minimum", async () => {
    const ctx = context("unused");
    let remaining = 1500;
    ctx.budget = () => remaining;
    const deadlines: number[] = [];
    const read = workspaceHeadReader(ctx, async (_args, options) => {
      deadlines.push(options?.timeoutSec ?? 0);
      return { ...heldRun(outboundFailure("invalid", "fixture")), code: 0 };
    });
    await read(["gh", "pr", "view", "7"], {});
    expect(deadlines).toEqual([1.5]);
    remaining = 500;
    expect((await read(["gh", "pr", "view", "7"], {})).stderr).toContain(
      "no forge request sent",
    );
    expect(deadlines).toEqual([1.5]);
  });

  it("uses the supplied asynchronous forge transport instead of the local command runner", async () => {
    const r = repos();
    let reads = 0;
    const why = await proveWorkspace(
      context(r.origin),
      r.clone,
      r.ws,
      7,
      BRANCH,
      "example-org/example-repo",
      async () => {
        reads += 1;
        return { status: 1, stdout: "", stderr: "forge held" };
      },
    );
    expect(reads).toBe(1);
    expect(why).toContain("forge held");
  });

  it("proves a checkout of the clone at the head", async () => {
    expect(await prove(repos())).toBeNull();
  });

  it("proves a checkout whose local commits descend from the head, and keeps them", async () => {
    const r = repos();
    writeFileSync(join(r.ws, "local.txt"), "local work\n");
    git("-C", r.ws, "add", "local.txt");
    git("-C", r.ws, "commit", "-q", "-m", "local");
    const at = git("-C", r.ws, "rev-parse", "HEAD");
    expect(await prove(r)).toBeNull();
    expect(git("-C", r.ws, "rev-parse", "HEAD")).toBe(at);
  });

  it("proves a checkout behind the head, fetching the head it lacks", async () => {
    const r = repos();
    const other = join(r.clone, "..", "pusher");
    git("clone", "-q", "-b", BRANCH, r.origin, other);
    writeFileSync(join(other, "later.txt"), "later\n");
    git("-C", other, "add", "later.txt");
    git("-C", other, "commit", "-q", "-m", "later");
    git("-C", other, "push", "-q", "origin", BRANCH);
    expect(await prove(r)).toBeNull();
    expect(git("-C", r.ws, "rev-parse", "HEAD")).toBe(r.head);
  });

  it("refuses a stale checkout of an earlier branch of the same name, and leaves its work", async () => {
    const r = repos();
    // The branch was replaced on the forge by one of another history.
    const other = join(r.clone, "..", "pusher");
    git("clone", "-q", "-b", "main", r.origin, other);
    git("-C", other, "checkout", "-q", "--orphan", BRANCH);
    writeFileSync(join(other, "new.txt"), "a new line\n");
    git("-C", other, "add", "new.txt");
    git("-C", other, "commit", "-q", "-m", "replaced");
    git("-C", other, "push", "-q", "-f", "origin", BRANCH);
    writeFileSync(join(r.ws, "unsaved.txt"), "unsaved work\n");
    const why = await prove(r);
    expect(why).toContain(
      `is at ${r.head}, which is neither the pull request head`,
    );
    expect(git("-C", r.ws, "rev-parse", "HEAD")).toBe(r.head);
    expect(readFileSync(join(r.ws, "unsaved.txt"), "utf8")).toBe(
      "unsaved work\n",
    );
  });

  it("refuses a checkout whose origin now points at another repository", async () => {
    const r = repos();
    expect(await prove(r, ELSEWHERE)).toBe(
      "PR #7: origin does not point at the head repository example-org/example-repo",
    );
  });

  it("refuses a changed origin even when its own same-numbered pull request and branch agree", async () => {
    const r = repos();
    expect(
      await proveWorkspace(
        context(r.origin, ELSEWHERE, true),
        r.clone,
        r.ws,
        7,
        BRANCH,
        "example-org/example-repo",
      ),
    ).not.toBeNull();
  });

  it("reports a failed ancestry read instead of treating it as another history", async () => {
    const r = repos();
    git("-C", r.ws, "checkout", "-q", "--detach", "HEAD~1");
    const ctx = context(r.origin);
    const run = ctx.run;
    ctx.run = (argv, options) =>
      argv.includes("merge-base")
        ? { status: 128, stdout: "", stderr: "cannot read commit graph" }
        : run(argv, options);
    expect(
      await proveWorkspace(
        ctx,
        r.clone,
        r.ws,
        7,
        BRANCH,
        "example-org/example-repo",
      ),
    ).toContain("cannot read commit graph");
  });

  it("refuses a checkout of another clone", async () => {
    const r = repos();
    const stranger = join(r.clone, "..", "stranger");
    git("clone", "-q", "-b", BRANCH, r.origin, stranger);
    expect(await prove(r, undefined, stranger)).toContain(
      `${stranger} belongs to the clone at`,
    );
  });

  it("refuses a folder that is no checkout at all, and creates nothing in it", async () => {
    const r = repos();
    const plain = join(r.clone, "..", "plain");
    mkdirSync(plain);
    expect(await prove(r, undefined, plain)).toContain(
      `cannot read the git common directory of ${plain}`,
    );
    expect(existsSync(join(plain, ".git"))).toBe(false);
  });
});
