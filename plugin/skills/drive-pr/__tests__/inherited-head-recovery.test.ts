/**
 * drive-pr suite: a pass killed with only uncommitted edits still owes the
 * round that settles them. The driver names the witnessed HEAD however the
 * work was left, and the gate reads that HEAD on the PR head itself as an
 * inherited one, so the drive cannot end before a pass has run. Before every
 * gate the driver also hands on commits a pass left unpushed on top of the
 * head branch's remote ref, and stops over commits that do not build on it.
 */

import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  describeLeftovers,
  inheritedHeadOf,
  type PassLeftovers,
} from "../scripts/lib/driver/restart.ts";
import {
  leftoverHeadOf,
  strandedReason,
  unpushedNotice,
  unpushedNoticeFor,
} from "../scripts/lib/driver/unpushed.ts";
import {
  headSyncState,
  mayEndWithoutWork,
} from "../scripts/lib/status/inherited-head.ts";

const HEAD = "a".repeat(40);
const leftovers = (
  uncommitted: string | null,
  unpushed: number | null,
  more: Partial<PassLeftovers> = {},
): PassLeftovers => ({
  uncommitted,
  unpushed,
  operation: null,
  head: HEAD,
  commits: [],
  onRemote: true,
  baseExists: true,
  edits: uncommitted,
  ...more,
});

describe("inheritedHeadOf", () => {
  it("names the head for uncommitted edits alone, and for unpushed commits", () => {
    expect(inheritedHeadOf(leftovers(" M a.ts", 0))).toBe(HEAD);
    expect(inheritedHeadOf(leftovers("", 2))).toBe(HEAD);
    expect(inheritedHeadOf(leftovers(null, 0))).toBe(HEAD);
  });

  it("names nothing for a clean, pushed tree", () => {
    expect(inheritedHeadOf(leftovers("", 0))).toBe("");
  });
});

describe("leftoverHeadOf", () => {
  it("names the head over commits on top of the remote ref", () => {
    expect(leftoverHeadOf(leftovers("", 1))).toBe(HEAD);
    expect(leftoverHeadOf(leftovers(" M a.ts", 3))).toBe(HEAD);
    // The gate checks the ancestry itself when the driver could not.
    expect(leftoverHeadOf(leftovers("", 1, { onRemote: null }))).toBe(HEAD);
  });

  it("names the head over uncommitted edits alone, so the round is owed", () => {
    expect(leftoverHeadOf(leftovers(" M a.ts", 0))).toBe(HEAD);
    expect(leftoverHeadOf(leftovers("?? fix.ts", null))).toBe(HEAD);
    expect(leftoverHeadOf(leftovers(" M a.ts", 0), "?? other.ts")).toBe(HEAD);
  });

  it("names nothing over edits the tree held before the last pass ran", () => {
    // Dirty at arm, or handed to a pass that left them as they were: the
    // drive stops over them at convergence instead of looping.
    expect(leftoverHeadOf(leftovers(" M a.ts", 0), " M a.ts")).toBe("");
  });

  it("names the head when a pass changed an edit its status line still shows the same", () => {
    const after = leftovers(" M a.ts", 0, { edits: " M a.ts\nafter" });
    expect(leftoverHeadOf(after, " M a.ts\nbefore")).toBe(HEAD);
    expect(leftoverHeadOf(after, " M a.ts\nafter")).toBe("");
  });

  it("names nothing for a tree with nothing to hand on", () => {
    // A pushed head the API lags behind: local HEAD is the remote ref. A head
    // an earlier measurement named is dropped once it was pushed.
    expect(leftoverHeadOf(leftovers("", 0))).toBe("");
    // No remote ref to count against (no upstream, no attach).
    expect(
      leftoverHeadOf(
        leftovers("", null, { onRemote: null, baseExists: false }),
      ),
    ).toBe("");
  });

  it("names nothing over commits that do not build on the remote ref", () => {
    expect(leftoverHeadOf(leftovers("", 1, { onRemote: false }))).toBe("");
  });

  it("keeps the earlier answer when a probe failed", () => {
    expect(leftoverHeadOf(leftovers("", 1, { head: null }))).toBeNull();
    expect(leftoverHeadOf(leftovers(null, 0))).toBeNull();
    expect(leftoverHeadOf(leftovers("", null, { onRemote: true }))).toBeNull();
    expect(leftoverHeadOf(leftovers(" M a.ts", 0, { edits: null }))).toBeNull();
    // Both commit probes failed over a ref that may exist: not "no commits".
    expect(
      leftoverHeadOf(leftovers("", null, { onRemote: null, baseExists: null })),
    ).toBeNull();
    expect(
      leftoverHeadOf(leftovers("", null, { onRemote: null, baseExists: true })),
    ).toBeNull();
  });
});

describe("unpushedNotice", () => {
  it("opens with what the tree holds", () => {
    expect(unpushedNotice(leftovers("", 1), HEAD)).toStartWith(
      "UNPUSHED COMMITS",
    );
    expect(unpushedNotice(leftovers(" M a.ts", 0), HEAD)).toStartWith(
      "UNCOMMITTED EDITS",
    );
  });
});

describe("strandedReason", () => {
  it("stops over unpushed commits that do not build on the remote ref", () => {
    const why = strandedReason(leftovers("", 2, { onRemote: false }));
    expect(why).toContain(`local HEAD ${HEAD}`);
    expect(why).toContain("does not build on");
  });

  it("lets every other tree through", () => {
    expect(strandedReason(leftovers("", 2))).toBeNull();
    expect(strandedReason(leftovers("", 2, { onRemote: null }))).toBeNull();
    // Behind the remote ref with nothing of its own: not a stranded commit.
    expect(strandedReason(leftovers("", 0, { onRemote: false }))).toBeNull();
    expect(strandedReason(leftovers("", null, { onRemote: false }))).toBeNull();
  });
});

describe("unpushedNoticeFor", () => {
  const notice = "UNPUSHED COMMITS: …";

  it("tells the pass about the unpushed commits", () => {
    expect(
      unpushedNoticeFor({
        inheritedHead: HEAD,
        passNotice: "",
        unpushedNotice: notice,
      }),
    ).toBe(notice);
  });

  it("says nothing twice when the restart notice already names the head", () => {
    expect(
      unpushedNoticeFor({
        inheritedHead: HEAD,
        passNotice: `RESTARTED AFTER A PASS DEADLINE … \`--inherited-head ${HEAD}\``,
        unpushedNotice: notice,
      }),
    ).toBe("");
  });
});

describe("describeLeftovers", () => {
  it("names each unpushed commit under the count", () => {
    const lines = describeLeftovers(
      leftovers("?? stray.txt", 2, {
        commits: ["1234567 second fix", "89abcde first fix"],
      }),
    );
    expect(lines).toContain("  ?? stray.txt");
    expect(lines).toContain("  1234567 second fix");
    expect(lines).toContain("  89abcde first fix");
  });

  it("says how many it did not list", () => {
    const lines = describeLeftovers(
      leftovers("", 30, { commits: ["1234567 newest fix"] }),
    );
    expect(lines).toContain("  … and 29 more");
  });
});

describe("headSyncState on the PR head", () => {
  it("reads the named head as inherited, so the drive does not end", async () => {
    const sync = await headSyncState(true, HEAD, HEAD, HEAD);
    expect(sync).toBe("inherited");
    expect(mayEndWithoutWork(0, sync, false)).toBe(false);
  });

  it("owes the round with head sync off too, the local head unread", async () => {
    expect(await headSyncState(false, HEAD, "", HEAD)).toBe("inherited");
    expect(await headSyncState(false, HEAD, HEAD, HEAD)).toBe("inherited");
  });

  it("stays in sync when no head is named, or another one is", async () => {
    expect(await headSyncState(true, HEAD, HEAD, "")).toBe("in-sync");
    expect(await headSyncState(true, HEAD, HEAD, "b".repeat(40))).toBe(
      "in-sync",
    );
    expect(await headSyncState(false, HEAD, "", "")).toBe("in-sync");
  });
});

describe("a head that was pushed, in a real tree", () => {
  const SELF = import.meta.dir;
  const cleanEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (
        v !== undefined &&
        !k.startsWith("GIT_") &&
        !k.startsWith("DRIVE_PR_")
      )
        env[k] = v;
    return env;
  };
  const git = (cwd: string, ...args: string[]): string => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd,
      env: cleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(r, 0);
    return r.stdout.toString().trim();
  };
  /** A tree on `main` at H, one commit past A, tracking `origin/main`. */
  const tree = (): { dir: string; a: string; h: string } => {
    const dir = mkdtempSync(join(tmpdir(), "inherited-head-"));
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.invalid");
    git(dir, "config", "user.name", "t");
    git(dir, "commit", "-q", "--allow-empty", "-m", "a");
    const a = git(dir, "rev-parse", "HEAD");
    git(dir, "commit", "-q", "--allow-empty", "-m", "h");
    const h = git(dir, "rev-parse", "HEAD");
    git(dir, "remote", "add", "origin", dir);
    git(dir, "config", "branch.main.remote", "origin");
    git(dir, "config", "branch.main.merge", "refs/heads/main");
    return { dir, a, h };
  };
  /** Run `code` in a child whose driven tree is `dir`; its stdout, trimmed. */
  const inTree = (
    dir: string,
    code: string,
    env: Record<string, string> = {},
  ): string => {
    const r = Bun.spawnSync(["bun", "-e", code], {
      cwd: dir,
      env: { ...cleanEnv(), DRIVE_PR_WORKTREE: dir, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(r, 0);
    return r.stdout.toString().trim();
  };
  const module = (rel: string): string => JSON.stringify(join(SELF, rel));
  const sync = (
    dir: string,
    a: string,
    h: string,
    branch: string,
    env: Record<string, string> = {},
  ): string =>
    inTree(
      dir,
      `import { headSyncState } from ${module("../scripts/lib/status/inherited-head.ts")};
       const e = process.env;
       console.log(await headSyncState(true, e.API, e.LOCAL, e.LOCAL, e.BRANCH));`,
      { API: a, LOCAL: h, BRANCH: branch, ...env },
    );
  /** Measure `dir` as a gate does; `before` is the tree as a completed pass found it. */
  const measure = (
    dir: string,
    inherited: string,
    before: string | null = null,
  ): Record<string, unknown> =>
    JSON.parse(
      inTree(
        dir,
        `import { measureUnpushed } from ${module("../scripts/lib/driver/unpushed.ts")};
         const context = {
           pr: "1",
           inheritedHead: process.env.INHERITED,
           unpushedNotice: "stale",
           uncommittedMeasured: null,
           uncommittedBeforePass: JSON.parse(process.env.BEFORE),
         };
         const code = await measureUnpushed(context);
         console.log(JSON.stringify({ code, ...context }));`,
        { INHERITED: inherited, BEFORE: JSON.stringify(before) },
      ),
    ) as Record<string, unknown>;

  it("polls the lag of a named head the head branch's remote ref carries", () => {
    const { dir, a, h } = tree();
    try {
      // Unpushed: the remote ref is behind H, so the named head passes.
      git(dir, "update-ref", "refs/remotes/origin/main", a);
      expect(sync(dir, a, h, "main")).toBe("inherited");
      // Pushed: the remote ref carries H, so the API lags a push.
      git(dir, "update-ref", "refs/remotes/origin/main", h);
      expect(sync(dir, a, h, "main")).toBe("lagging");
      // Another branch's remote ref says nothing about this PR's head.
      expect(sync(dir, a, h, "other")).toBe("inherited");
      // With no head branch named, whether H was pushed cannot be read.
      expect(sync(dir, a, h, "")).toBe("lagging");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads only the drive's own remote for whether the head was pushed", () => {
    const { dir, a, h } = tree();
    try {
      git(dir, "remote", "add", "upstream", dir);
      git(dir, "update-ref", "refs/remotes/origin/main", h);
      git(dir, "update-ref", "refs/remotes/upstream/main", a);
      const upstream = { JIG__REPOSITORY__REMOTE: "upstream" };
      // origin carries H, but the drive pushes to upstream, which does not.
      expect(sync(dir, a, h, "main", upstream)).toBe("inherited");
      git(dir, "update-ref", "refs/remotes/upstream/main", h);
      expect(sync(dir, a, h, "main", upstream)).toBe("lagging");
      // A remote setting that cannot be read cannot say H was not pushed.
      git(dir, "update-ref", "refs/remotes/upstream/main", a);
      expect(sync(dir, a, h, "main", { JIG__REPOSITORY__REMOTE: "-bad" })).toBe(
        "lagging",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops an inherited head once the tree has nothing left to hand on", () => {
    const { dir, h } = tree();
    try {
      git(dir, "update-ref", "refs/remotes/origin/main", h);
      expect(measure(dir, h)).toMatchObject({
        code: null,
        inheritedHead: "",
        unpushedNotice: "",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands on uncommitted edits, untracked files included whatever git's configuration", () => {
    const { dir, h } = tree();
    try {
      git(dir, "update-ref", "refs/remotes/origin/main", h);
      git(dir, "config", "status.showUntrackedFiles", "no");
      writeFileSync(join(dir, "fix.ts"), "fix\n");
      // A pass that found the tree clean left the edit.
      const context = measure(dir, "", "");
      expect(context.inheritedHead).toBe(h);
      expect(String(context.unpushedNotice)).toStartWith("UNCOMMITTED EDITS");
      expect(String(context.unpushedNotice)).toContain("?? fix.ts");
      // A tree already dirty at arm hands nothing on.
      const atArm = measure(dir, "");
      expect(atArm.inheritedHead).toBe("");
      expect(String(atArm.uncommittedBeforePass)).toStartWith("?? fix.ts\n");
      // A pass that changed the untracked file's content left work.
      const before = String(atArm.uncommittedBeforePass);
      writeFileSync(join(dir, "fix.ts"), "fixed further\n");
      expect(measure(dir, "", before).inheritedHead).toBe(h);
      // A new file in a directory already untracked: the status line stays
      // `?? scratch/`, the files under it do not.
      mkdirSync(join(dir, "scratch"));
      writeFileSync(join(dir, "scratch", "a.ts"), "a\n");
      const withDir = String(measure(dir, "").uncommittedBeforePass);
      writeFileSync(join(dir, "scratch", "b.ts"), "b\n");
      expect(measure(dir, "", withDir).inheritedHead).toBe(h);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands on a further edit to a file its status line already showed as modified", () => {
    const { dir } = tree();
    try {
      writeFileSync(join(dir, "a.ts"), "one\n");
      git(dir, "add", "a.ts");
      git(dir, "commit", "-q", "-m", "a.ts");
      const h = git(dir, "rev-parse", "HEAD");
      git(dir, "update-ref", "refs/remotes/origin/main", h);
      writeFileSync(join(dir, "a.ts"), "two\n");
      const handed = measure(dir, "");
      expect(handed.inheritedHead).toBe("");
      const before = String(handed.uncommittedBeforePass);
      // Left exactly as it was handed: nothing to hand on.
      expect(measure(dir, "", before).inheritedHead).toBe("");
      // Edited again: the status line is still ` M a.ts`, the content is not.
      writeFileSync(join(dir, "a.ts"), "three\n");
      expect(measure(dir, "", before).inheritedHead).toBe(h);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands on an untracked file whose name holds a newline", () => {
    const { dir, h } = tree();
    try {
      git(dir, "update-ref", "refs/remotes/origin/main", h);
      writeFileSync(join(dir, "fix\npart.ts"), "fix\n");
      const handed = measure(dir, "", "");
      expect(handed.inheritedHead).toBe(h);
      expect(handed.uncommittedMeasured).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands on an untracked symbolic link retargeted or left dangling", () => {
    const { dir, h } = tree();
    try {
      git(dir, "update-ref", "refs/remotes/origin/main", h);
      writeFileSync(join(dir, "one.txt"), "same\n");
      writeFileSync(join(dir, "two.txt"), "same\n");
      symlinkSync("one.txt", join(dir, "link"));
      const before = String(measure(dir, "").uncommittedBeforePass);
      expect(measure(dir, "", before).inheritedHead).toBe("");
      // Retargeted between files of the same contents.
      rmSync(join(dir, "link"));
      symlinkSync("two.txt", join(dir, "link"));
      expect(measure(dir, "", before).inheritedHead).toBe(h);
      // Left dangling: still measured, and still a change.
      rmSync(join(dir, "link"));
      symlinkSync("missing.txt", join(dir, "link"));
      const dangling = measure(dir, "", before);
      expect(dangling.uncommittedMeasured).not.toBeNull();
      expect(dangling.inheritedHead).toBe(h);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands on an edit a configured text converter leaves out", () => {
    const { dir } = tree();
    try {
      // The converter keeps only the first line, so the edit below is
      // invisible to a converted diff.
      writeFileSync(join(dir, ".gitattributes"), "*.dat diff=first\n");
      git(dir, "config", "diff.first.textconv", "head -n 1");
      writeFileSync(join(dir, "a.dat"), "same\none\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "a.dat");
      const h = git(dir, "rev-parse", "HEAD");
      git(dir, "update-ref", "refs/remotes/origin/main", h);
      writeFileSync(join(dir, "a.dat"), "same\ntwo\n");
      const before = String(measure(dir, "").uncommittedBeforePass);
      writeFileSync(join(dir, "a.dat"), "same\nthree\n");
      expect(measure(dir, "", before).inheritedHead).toBe(h);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands on a further edit inside an already-dirty submodule", () => {
    const { dir } = tree();
    const lib = mkdtempSync(join(tmpdir(), "inherited-head-lib-"));
    try {
      git(lib, "init", "-q", "-b", "main");
      git(lib, "config", "user.email", "t@example.invalid");
      git(lib, "config", "user.name", "t");
      writeFileSync(join(lib, "x.ts"), "one\n");
      git(lib, "add", "x.ts");
      git(lib, "commit", "-q", "-m", "x");
      git(
        dir,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        lib,
        "lib",
      );
      git(dir, "commit", "-q", "-m", "lib");
      const h = git(dir, "rev-parse", "HEAD");
      git(dir, "update-ref", "refs/remotes/origin/main", h);
      writeFileSync(join(dir, "lib", "x.ts"), "two\n");
      const before = String(measure(dir, "").uncommittedBeforePass);
      // Left as handed: nothing to hand on.
      expect(measure(dir, "", before).inheritedHead).toBe("");
      // Edited again inside the submodule: the superproject's status and
      // diff are unchanged.
      writeFileSync(join(dir, "lib", "x.ts"), "three\n");
      expect(measure(dir, "", before).inheritedHead).toBe(h);
      // A new untracked file inside it counts too.
      writeFileSync(join(dir, "lib", "x.ts"), "two\n");
      writeFileSync(join(dir, "lib", "new.ts"), "new\n");
      expect(measure(dir, "", before).inheritedHead).toBe(h);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(lib, { recursive: true, force: true });
    }
  });
});
