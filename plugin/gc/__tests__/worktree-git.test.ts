import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { gcGit, gitEnvironment } from "../git.ts";
import { ancestry } from "../kinds/worktree-git.ts";
import {
  classifyIgnored,
  detachedSource,
  worktreeProof,
} from "../kinds/worktree-proof.ts";

function repository() {
  const root = mkdtempSync(join(tmpdir(), "gc-git-observation-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], {
      env: gitEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    expectSpawnExit(result, 0);
  };
  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "tracked.txt"), "retained\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  return { root, repo, git };
}

test("read-only status cannot run a configured monitor hook or refresh the index", async () => {
  const f = repository();
  const marker = join(f.root, "hook-ran");
  const hook = writeFakeProgram(
    join(f.root, "monitor"),
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdout.write("token\\0");
`,
  );
  f.git("config", "core.fsmonitor", hook);
  f.git("config", "core.fsmonitorHookVersion", "2");
  writeFileSync(join(f.repo, "tracked.txt"), "retained\n");
  const index = join(f.repo, ".git", "index");
  const before = readFileSync(index);
  await gcGit(f.repo, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
  ]);
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(index)).toEqual(before);
});

test("collector ref updates cannot run a hook from the configured hooks path", async () => {
  const f = repository();
  const marker = join(f.root, "hook-ran");
  const hooks = join(f.repo, ".githooks");
  mkdirSync(hooks);
  writeFakeProgram(
    join(hooks, "reference-transaction"),
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
`,
  );
  f.git("config", "core.hooksPath", ".githooks");
  await gcGit(f.repo, ["update-ref", "refs/jig-gc/probe", "HEAD"]);
  await gcGit(f.repo, ["update-ref", "--no-deref", "-d", "refs/jig-gc/probe"]);
  expect(existsSync(marker)).toBe(false);
});

test("pull request evidence excludes identically named branches in unrelated forks", () => {
  const f = repository();
  f.git("remote", "add", "origin", "https://github.com/team/repo.git");
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const entry = (state: string, owner: string) => ({
    state,
    headRefOid: "a".repeat(40),
    headRepository: { name: "repo" },
    headRepositoryOwner: { login: owner },
  });
  writeFakeProgram(
    join(bin, "gh"),
    `#!/usr/bin/env bun
console.log(JSON.stringify(${JSON.stringify([entry("MERGED", "other"), entry("OPEN", "another"), entry("CLOSED", "Team")])}));
`,
  );
  const source = `import { requests } from ${JSON.stringify(resolve(import.meta.dir, "../kinds/worktree-git.ts"))};
console.log(JSON.stringify(await requests(${JSON.stringify(f.repo)}, "origin", "topic")));`;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
      "-e",
      source,
    ],
    {
      cwd: f.repo,
      env: {
        ...gitEnvironment(),
        PATH: `${bin}${delimiter}${process.env.PATH}`,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  expectSpawnExit(result, 0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    ok: true,
    value: [{ state: "CLOSED", head: "a".repeat(40) }],
  });
});

test("submodule settings cannot hide edits or execute a monitor during a report", async () => {
  const f = repository();
  const source = repository();
  f.git(
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    source.repo,
    "child",
  );
  f.git("commit", "-am", "add submodule");
  f.git("config", "submodule.child.ignore", "all");
  const marker = join(f.root, "child-monitor-ran");
  const hook = writeFakeProgram(
    join(f.root, "child-monitor"),
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdout.write("token\\0");
`,
  );
  const child = join(f.repo, "child");
  f.git("-C", child, "config", "core.fsmonitor", hook);
  writeFileSync(join(child, "tracked.txt"), "personal edits\n");
  expect(
    await worktreeProof(f.repo, { remote: "origin", base: "main" }, 7),
  ).toMatchObject({
    ok: true,
    value: { state: "live", reason: "uncommitted or untracked changes" },
  });
  expect(existsSync(marker)).toBe(false);
});

/**
 * Run `source` in a child Bun inside `f.repo`, with the fake `gh` in
 * `f.root/bin` first on the path; the JSON it prints.
 */
function runInChild(
  f: ReturnType<typeof repository>,
  source: string,
): Record<string, unknown> {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
      "-e",
      source,
    ],
    {
      cwd: f.repo,
      env: {
        ...gitEnvironment(),
        PATH: `${join(f.root, "bin")}${delimiter}${process.env.PATH}`,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  expectSpawnExit(result, 0);
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
}

/** The commit `f.repo` has checked out. */
function headOf(f: ReturnType<typeof repository>): string {
  return Bun.spawnSync(["git", "-C", f.repo, "rev-parse", "HEAD"], {
    env: gitEnvironment(),
  })
    .stdout.toString()
    .trim();
}

/** One entry of the forge's pull requests for a commit, in its REST form. */
function commitPull(
  number: number,
  state: "OPEN" | "MERGED" | "CLOSED",
  head: string,
  source = "team/repo",
) {
  return {
    number,
    state: state === "OPEN" ? "open" : "closed",
    merged_at: state === "MERGED" ? "2026-11-01T00:00:00Z" : null,
    head: { sha: head, repo: { full_name: source } },
  };
}

/**
 * Prove the detached worktree `f.repo` in a child with `gh` answering the pull
 * request `pr` (a JS expression) to `pr view` and `pulls` to the forge's
 * pull requests for a commit, after writing a tree record for `head` (a JS
 * expression, or none); the proof's result or its error, as JSON.
 */
function detachedProof(
  f: ReturnType<typeof repository>,
  options: {
    pr: string | null;
    head: string | null;
    remote: string;
    pulls?: unknown;
  },
) {
  const bin = join(f.root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFakeProgram(
    join(bin, "gh"),
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(f.root, "gh-calls"))}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "api") console.log(JSON.stringify(${JSON.stringify(options.pulls ?? [])}));
else if (${options.pr === null}) { console.error("gh: Could not resolve to a PullRequest"); process.exit(1); }
else console.log(JSON.stringify({ ...${options.pr ?? "{}"}, headRepository: { name: "repo" }, headRepositoryOwner: { login: "team" } }));
`,
  );
  const source = `import { writeDrivenTree } from ${JSON.stringify(resolve(import.meta.dir, "../../shared/driven-tree.ts"))};
import { worktreeProof } from ${JSON.stringify(resolve(import.meta.dir, "../kinds/worktree-proof.ts"))};
if (${options.head !== null}) writeDrivenTree(${JSON.stringify(join(f.repo, ".git"))}, { pr: 7, branch: "topic", remote: "upstream", created: true, head: ${options.head} });
try { console.log(JSON.stringify(await worktreeProof(${JSON.stringify(f.repo)}, { remote: ${JSON.stringify(options.remote)}, base: "main" }, 7))); }
catch (error) { console.log(JSON.stringify({ error: String(error) })); }`;
  return runInChild(f, source);
}

/** What the fake `gh` was asked, one call per line. */
function ghCalls(f: ReturnType<typeof repository>): string {
  return readFileSync(join(f.root, "gh-calls"), "utf8");
}

test("a detached worktree is proven by the pull request a drive attached it to, through the remote it was attached from", () => {
  const f = repository();
  f.git("remote", "add", "origin", "https://github.com/fork/repo.git");
  f.git("remote", "add", "upstream", "https://github.com/team/repo.git");
  f.git("checkout", "--quiet", "--detach");
  const pr = `{ number: 7, state: "OPEN", headRefOid: "a".repeat(40) }`;
  const head = `Bun.spawnSync(["git", "-C", ${JSON.stringify(f.repo)}, "rev-parse", "HEAD"]).stdout.toString().trim()`;
  expect(detachedProof(f, { pr, head, remote: "origin" })).toMatchObject({
    ok: true,
    value: {
      state: "live",
      reason:
        "branch has an open pull request; HEAD is detached; pull request #7 is named by the drive's tree record",
    },
  });
  expect(ghCalls(f)).toContain("pr view 7 --repo github.com/team/repo");
  expect(ghCalls(f)).not.toContain("api");
});

test("a detached worktree no drive recorded is judged by the pull requests the forge lists for its commit", () => {
  const f = repository();
  f.git("remote", "add", "origin", "https://github.com/team/repo.git");
  f.git("checkout", "--quiet", "--detach");
  const head = headOf(f);
  const pulls = [
    commitPull(9, "OPEN", head),
    // A fork's pull request is this repository's pull request all the same.
    commitPull(10, "MERGED", head, "other/repo"),
  ];
  expect(
    detachedProof(f, { pr: "{}", head: null, remote: "origin", pulls }),
  ).toMatchObject({
    ok: true,
    value: {
      state: "live",
      reason:
        "branch has an open pull request; HEAD is detached; the forge lists pull requests #9, #10 as holding its commit",
    },
  });
  expect(ghCalls(f)).toContain(
    `api --hostname github.com repos/team/repo/commits/${head}/pulls?per_page=100`,
  );
});

test("a commit lookup the forge cannot answer in full, or answers malformed, fails the proof", () => {
  const f = repository();
  f.git("remote", "add", "origin", "https://github.com/team/repo.git");
  f.git("checkout", "--quiet", "--detach");
  const head = headOf(f);
  const full = Array.from({ length: 100 }, (_, i) =>
    commitPull(i + 1, "MERGED", head),
  );
  expect(
    detachedProof(f, { pr: "{}", head: null, remote: "origin", pulls: full }),
  ).toMatchObject({ ok: false, failure: { code: "incomplete" } });
  const unnumbered = [{ ...commitPull(1, "MERGED", head), number: "1" }];
  expect(
    detachedProof(f, {
      pr: "{}",
      head: null,
      remote: "origin",
      pulls: unnumbered,
    }),
  ).toMatchObject({ ok: false, failure: { code: "malformed" } });
});

/**
 * The forge's pull requests for commit `head` of `f.repo`, as
 * `requestsForCommit` reads them, with `gh` answering `stdout`, or failing
 * with `stderr` when that is given.
 */
function commitLookup(
  f: ReturnType<typeof repository>,
  head: string,
  answer: { stdout?: unknown; stderr?: string },
) {
  const bin = join(f.root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFakeProgram(
    join(bin, "gh"),
    answer.stderr === undefined
      ? `#!/usr/bin/env bun
console.log(${JSON.stringify(JSON.stringify(answer.stdout))});
`
      : `#!/usr/bin/env bun
console.error(${JSON.stringify(answer.stderr)}); process.exit(1);
`,
  );
  const source = `import { requestsForCommit } from ${JSON.stringify(resolve(import.meta.dir, "../kinds/worktree-git.ts"))};
console.log(JSON.stringify(await requestsForCommit(${JSON.stringify(f.repo)}, "origin", ${JSON.stringify(head)})));`;
  return runInChild(f, source);
}

// The endpoint lists open and merged pull requests; the CLOSED record only
// pins how a state it did return is read.
test("the commit lookup keeps every pull request the forge lists, a fork's or a deleted fork's included", () => {
  const f = repository();
  f.git("remote", "add", "origin", "https://github.com/team/repo.git");
  const head = headOf(f);
  const gone = {
    ...commitPull(4, "MERGED", head),
    head: { sha: head, repo: null },
  };
  expect(
    commitLookup(f, head, {
      stdout: [
        commitPull(1, "MERGED", head),
        commitPull(2, "CLOSED", head),
        commitPull(3, "OPEN", "b".repeat(40)),
        gone,
      ],
    }),
  ).toEqual({
    ok: true,
    value: [
      { state: "MERGED", head, number: 1 },
      { state: "CLOSED", head, number: 2 },
      { state: "OPEN", head: "b".repeat(40), number: 3 },
      { state: "MERGED", head, number: 4 },
    ],
  });
});

test("a commit the forge does not have is in no pull request; any other refusal fails the lookup", () => {
  const f = repository();
  f.git("remote", "add", "origin", "https://github.com/team/repo.git");
  const head = headOf(f);
  expect(
    commitLookup(f, head, {
      stderr: `gh: No commit found for SHA: ${head} (HTTP 422)`,
    }),
  ).toEqual({ ok: true, value: [] });
  expect(
    commitLookup(f, head, { stderr: "gh: Bad credentials (HTTP 401)" }),
  ).toMatchObject({ ok: false, failure: { code: "forge-unavailable" } });
});

test("a drive record git cannot check, or whose pull request cannot be read, leaves the tree unverified", () => {
  const f = repository();
  f.git("remote", "add", "upstream", "https://github.com/team/repo.git");
  f.git("checkout", "--quiet", "--detach");
  // A commit this repository does not hold: git cannot tell its descent.
  const missing = JSON.stringify("c".repeat(40));
  expect(
    detachedProof(f, { pr: "{}", head: missing, remote: "upstream" }),
  ).toMatchObject({ ok: false, failure: { code: "unverifiable" } });
  expect(
    detachedProof(f, {
      pr: null,
      head: JSON.stringify(headOf(f)),
      remote: "upstream",
    }),
  ).toMatchObject({ ok: false, failure: { code: "forge-unavailable" } });
  expect(ghCalls(f)).not.toContain("api");
});

test("a detached worktree moved onto a stacked branch's work is not proven by the merged pull request it was attached to", () => {
  const f = repository();
  f.git("remote", "add", "upstream", "https://github.com/team/repo.git");
  const attached = headOf(f);
  f.git("checkout", "--quiet", "--detach");
  writeFileSync(join(f.repo, "stacked.txt"), "stacked\n");
  f.git("add", ".");
  f.git("commit", "--quiet", "-m", "stacked");
  // The descendant is a stacked pull request's, pushed to its own branch.
  f.git("update-ref", "refs/remotes/upstream/stacked", "HEAD");
  const head = JSON.stringify(attached);
  const pr = (state: string) =>
    `{ number: 7, state: "${state}", headRefOid: ${head} }`;
  const pulls = [commitPull(8, "OPEN", headOf(f))];
  // The record no longer describes the head, so the forge's pull requests
  // for the commit judge it, never the merged one the record names.
  expect(
    detachedProof(f, {
      pr: pr("MERGED"),
      head,
      remote: "upstream",
      pulls,
    }),
  ).toMatchObject({
    ok: true,
    value: {
      state: "live",
      reason:
        "branch has an open pull request; HEAD is detached; the forge lists pull request #8 as holding its commit",
    },
  });
  // The record's own branch holding the head makes it the drive's work again
  // (an open pull request, so the proof ends before any remote is read).
  f.git("update-ref", "refs/remotes/upstream/topic", "HEAD");
  expect(
    detachedProof(f, { pr: pr("OPEN"), head, remote: "upstream", pulls }),
  ).toMatchObject({
    ok: true,
    value: {
      state: "live",
      reason: expect.stringContaining(
        "pull request #7 is named by the drive's tree record",
      ),
    },
  });
});

test("a drive record whose pull request counted as none is not reported as naming the proof", () => {
  const record = { pr: 7 } as Parameters<typeof detachedSource>[1];
  expect(detachedSource([], record)).toBe(
    "HEAD is detached; the drive's tree record names pull request #7, which counts as no pull request holding its commit",
  );
  expect(
    detachedSource([{ state: "OPEN", head: "a", number: 7 }], record),
  ).toBe(
    "HEAD is detached; pull request #7 is named by the drive's tree record",
  );
});

test("the worktree policy reads the configured remote and that remote's HEAD", () => {
  const f = repository();
  f.git("remote", "add", "upstream", "https://github.com/team/repo.git");
  f.git("update-ref", "refs/remotes/upstream/trunk", "HEAD");
  f.git(
    "symbolic-ref",
    "refs/remotes/upstream/HEAD",
    "refs/remotes/upstream/trunk",
  );
  mkdirSync(join(f.repo, ".config"));
  writeFileSync(
    join(f.repo, ".config", "jig.yaml"),
    "repository:\n  remote: upstream\n",
  );
  const source = `import { worktreePolicy } from ${JSON.stringify(resolve(import.meta.dir, "../kinds/worktree-proof.ts"))};
console.log(JSON.stringify(await worktreePolicy(${JSON.stringify(f.repo)})));`;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
      "-e",
      source,
    ],
    {
      cwd: f.repo,
      env: { ...gitEnvironment(), JIG_OVERLAY: "", JIG_USER_LAYER: "off" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  expectSpawnExit(result, 0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    ok: true,
    value: { remote: "upstream", base: "trunk" },
  });
});

test("ancestry ignores a replacement ref that fabricates descent", async () => {
  const f = repository();
  const revision = async () => {
    const read = await gcGit(f.repo, ["rev-parse", "HEAD"]);
    if (!read.ok) throw new Error(read.failure.reason);
    return read.value.trim();
  };
  const head = await revision();
  writeFileSync(join(f.repo, "tracked.txt"), "second\n");
  f.git("commit", "-am", "second");
  const second = await revision();
  f.git("checkout", "--orphan", "other");
  f.git("commit", "-m", "unrelated", "--allow-empty");
  const other = await revision();
  expect(await ancestry(f.repo, head, other)).toBe(false);
  // Replace the unrelated tip with a commit that descends from `head`.
  f.git("replace", other, second);
  expect(await ancestry(f.repo, head, other)).toBe(false);
});

/** The ignored-content scan's failure past its deadline. */
const timedOut = {
  ok: false,
  failure: {
    code: "timed-out",
    reason: "Ignored-content scan exceeded its deadline",
  },
};
test("the ignored-content scan fails once its deadline has passed", () => {
  const root = mkdtempSync(join(tmpdir(), "gc-ignored-deadline-"));
  mkdirSync(join(root, "website", "node_modules"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  expect(classifyIgnored(root, ["website/"], Date.now() - 1)).toMatchObject(
    timedOut,
  );
  expect(classifyIgnored(root, ["website/"])).toMatchObject({
    ok: true,
    value: { rebuildable: ["website/"] },
  });
});

test("the deadline also covers a direct dependency directory and an empty one", () => {
  const root = mkdtempSync(join(tmpdir(), "gc-ignored-deadline-"));
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "empty"));
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  for (const path of ["node_modules/", "empty/"])
    expect(classifyIgnored(root, [path], Date.now() - 1)).toMatchObject(
      timedOut,
    );
});

test("the deadline expiring mid-traversal stops the walk of a collapsed directory", () => {
  const root = mkdtempSync(join(tmpdir(), "gc-ignored-deadline-"));
  mkdirSync(join(root, "website", "packages", "node_modules"), {
    recursive: true,
  });
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  // The clock reads inside the budget for `ticks` checks, then past it. The
  // walk makes five: one per path, one entering each of `website` and
  // `packages`, and one per entry in each.
  const scan = (ticks: number) => {
    let reads = 0;
    const clock = spyOn(Temporal.Now, "instant").mockImplementation(() =>
      Temporal.Instant.fromEpochMilliseconds(++reads <= ticks ? 0 : 2),
    );
    try {
      return classifyIgnored(root, ["website/"], 1);
    } finally {
      clock.mockRestore();
    }
  };
  for (const ticks of [1, 2, 3, 4]) expect(scan(ticks)).toMatchObject(timedOut);
  expect(scan(5)).toMatchObject({
    ok: true,
    value: { rebuildable: ["website/"] },
  });
});
