/**
 * drive-pr suite: drive-status.ts over a head the reviewer skipped. The
 * reviewer's sticky comment names, in a skip-notice block, a pushed head it
 * did not review; its reviewed-SHA marker stays on the earlier head. A skip
 * of the current head whose pull-request diff equals the reviewed head's is
 * judged on the reviewed head; any other skip of the current head stops as
 * `REVIEW_SKIPPED`; a notice naming another head changes nothing.
 * Shared fixtures live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import {
  binDir,
  type Fixture,
  gitCleanEnv,
  makeScratchRepo,
  REVIEWER_RUN,
  SCRIPTS,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { realGitForShell } from "./round-plan-fixtures.ts";

useDrivePrSuite();

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: gitCleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(r, 0);
  return r.stdout.toString().trim();
}

function commitFile(
  cwd: string,
  name: string,
  text: string | Uint8Array,
): string {
  mkdirSync(dirname(join(cwd, name)), { recursive: true });
  writeFileSync(join(cwd, name), text);
  git(cwd, "add", name);
  git(cwd, "commit", "-qm", `edit ${name}`, "--no-verify");
  return git(cwd, "rev-parse", "HEAD");
}

type Files = Record<string, string | Uint8Array>;

/**
 * A pull request whose `reviewed` head writes `change` over the seed's
 * `files`, and whose `merged` head merges a base that moved on with a file of
 * its own (`base`), its merge resolution writing `resolution`.
 */
function mergedHistory(
  name: string,
  files: Files,
  change: Files,
  resolution: Files,
) {
  const repo = makeScratchRepo(name);
  for (const [file, text] of Object.entries(files))
    commitFile(repo.dir, file, text);
  git(repo.dir, "checkout", "-q", "-b", "feature");
  for (const [file, text] of Object.entries(change))
    commitFile(repo.dir, file, text);
  const reviewed = git(repo.dir, "rev-parse", "HEAD");
  git(repo.dir, "checkout", "-q", "main");
  const base = commitFile(repo.dir, "base.txt", "from the base\n");
  git(repo.dir, "checkout", "-q", "feature");
  git(repo.dir, "merge", "-q", "--no-ff", "--no-commit", "main");
  for (const [file, text] of Object.entries(resolution)) {
    writeFileSync(join(repo.dir, file), text);
    git(repo.dir, "add", file);
  }
  git(repo.dir, "commit", "-q", "--no-edit", "--no-verify");
  const merged = git(repo.dir, "rev-parse", "HEAD");
  return { dir: repo.dir, base, reviewed, merged, changed: merged };
}

const LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const withNewAfter = (n: number) =>
  `${[...LINES.slice(0, n), "NEW", ...LINES.slice(n)].join("\n")}\n`;

/**
 * A pull request's history: `reviewed` (the head the reviewer reviewed) edits
 * `feature.txt` on a branch off the base; the base then moves on with a file
 * of its own (`base`); `merged` merges that base in, which leaves the pull
 * request's own diff unchanged; `changed` edits the feature on top of it.
 */
function pullRequestRepo(name: string, baseConfig?: string) {
  const repo = makeScratchRepo(name);
  commitFile(repo.dir, "feature.txt", "one\ntwo\nthree\n");
  git(repo.dir, "checkout", "-q", "-b", "feature");
  const reviewed = commitFile(repo.dir, "feature.txt", "one\nTWO\nthree\n");
  git(repo.dir, "checkout", "-q", "main");
  commitFile(repo.dir, "base.txt", "from the base\n");
  if (baseConfig !== undefined)
    commitFile(repo.dir, ".config/jig.yaml", baseConfig);
  const base = git(repo.dir, "rev-parse", "HEAD");
  git(repo.dir, "checkout", "-q", "feature");
  git(repo.dir, "merge", "-q", "--no-ff", "--no-edit", "main");
  const merged = git(repo.dir, "rev-parse", "HEAD");
  const changed = commitFile(repo.dir, "feature.txt", "one\nTWO\nTHREE\n");
  return { dir: repo.dir, base, reviewed, merged, changed };
}

const SKIP_MARKER = "ai-review-skip-notice";

function skipNotice(head: string, marker = SKIP_MARKER): string {
  return [
    `<!-- ${marker} -->`,
    "> [!WARNING]",
    `> **Review did not run** for push \`${head.slice(0, 12)}\` — skipped: empty diff (nothing to review after excludes). A green check on this run does not mean the push was reviewed.`,
    `<!-- /${marker} -->`,
  ].join("\n");
}

interface Comment {
  id: number;
  body: string;
  user: { login: string };
  author_association: string;
  updated_at: string;
}

/** Put `notice` into the fixture's sticky comment, right below its marker. */
function addToSticky(dir: string, notice: string): void {
  const path = join(dir, "issue-comments.json");
  const comments = JSON.parse(readFileSync(path, "utf8")) as Comment[];
  const sticky = comments.find((c) =>
    c.body.startsWith("<!-- ai-code-review -->"),
  );
  if (sticky === undefined) throw new Error("the fixture has no sticky");
  sticky.body = sticky.body.replace(
    "<!-- ai-code-review -->",
    `<!-- ai-code-review -->\n${notice}`,
  );
  writeFileSync(path, JSON.stringify(comments));
}

/** Post `body` as a later comment by `login`. */
function addComment(dir: string, login: string, body: string): void {
  const path = join(dir, "issue-comments.json");
  const comments = JSON.parse(readFileSync(path, "utf8")) as Comment[];
  const last = comments.at(-1);
  comments.push({
    id: 7000 + comments.length,
    body,
    user: { login },
    author_association: login.endsWith("[bot]") ? "NONE" : "OWNER",
    updated_at: last?.updated_at ?? new Date().toISOString(),
  });
  writeFileSync(path, JSON.stringify(comments));
}

function addUnstampedSkip(dir: string, head: string): void {
  addComment(
    dir,
    "example-review[bot]",
    `<!-- ai-code-review -->\n${skipNotice(head)}`,
  );
}

async function gate(
  tree: string,
  fixture: Fixture,
  notice: string | null,
  env: Record<string, string> = {},
  edit?: (dir: string) => void,
) {
  const { dir, stateDir } = writeFixture(fixture, tree);
  if (notice !== null) addToSticky(dir, notice);
  edit?.(dir);
  const proc = Bun.spawn(
    scriptArgv(join(SCRIPTS, "drive-status.ts"), "999", "--json", "--once"),
    {
      cwd: tree,
      env: {
        ...gitCleanEnv(),
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        DRIVE_PR_FIXTURES: dir,
        DRIVE_PR_STATE_DIR: stateDir,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const report = stdout.trim() === "" ? {} : JSON.parse(stdout);
  return {
    stdout,
    stderr,
    exitCode,
    state: String(report.state ?? ""),
    reason: String(report.reason ?? ""),
    reviewer: (report.reviewer ?? {}) as Record<string, unknown>,
  };
}

/** The pull request at `head`, checked out, with the reviewer's marker on `reviewed`. */
function at(
  repo: { dir: string; base: string; reviewed: string },
  head: string,
  base = repo.base,
): Fixture {
  git(repo.dir, "checkout", "-q", "--detach", head);
  return { threads: [], head, base, reviewedSha: repo.reviewed };
}

describe("drive-status.ts over a head the reviewer skipped", () => {
  it.each([
    [
      "all changed paths excluded",
      ["feature.txt"],
      "neutral",
      22,
      "REVIEW_SKIPPED",
    ],
    [
      "all changed paths excluded despite a skipped check",
      ["feature.txt"],
      "skipped",
      22,
      "REVIEW_SKIPPED",
    ],
    ["no configured exclusions", null, "neutral", 22, "REVIEW_SKIPPED"],
    [
      "a remaining changed path",
      ["unrelated.txt"],
      "neutral",
      22,
      "REVIEW_SKIPPED",
    ],
  ] as const)(
    "judges an unstamped current-head skip with %s",
    async (caseName, exclusions, conclusion, exit, state) => {
      const baseConfig =
        exclusions === null
          ? undefined
          : `review:\n  skip_excluded_paths: ${JSON.stringify(exclusions)}\n`;
      const repo = pullRequestRepo(caseName.replaceAll(" ", "-"), baseConfig);
      const fixture = {
        ...at(repo, repo.merged),
        reviewedSha: null,
        checkRuns: [{ ...REVIEWER_RUN, conclusion }],
      };
      const result = await gate(repo.dir, fixture, null, {}, (dir) =>
        addUnstampedSkip(dir, repo.merged),
      );
      expectSpawnExit(result, exit);
      expect(result.state).toBe(state);
      expect(result.reason).toContain(repo.merged);
      expect(result.reason).toContain("skip notice");
    },
  );

  it("keeps the skip evidence when the reviewer posts an auxiliary reply", async () => {
    const repo = pullRequestRepo(
      "unstamped-auxiliary-reply",
      "review:\n  skip_excluded_paths: [feature.txt]\n",
    );
    const fixture = { ...at(repo, repo.merged), reviewedSha: null };
    const result = await gate(repo.dir, fixture, null, {}, (dir) => {
      addUnstampedSkip(dir, repo.merged);
      addComment(
        dir,
        "example-review[bot]",
        "<!-- ai-code-review -->\nAcknowledged.",
      );
    });
    expectSpawnExit(result, 22);
    expect(result.reason).toContain("policy base could not be resolved");
  });

  it("stops when equally good merge bases give different diffs", async () => {
    const repo = makeScratchRepo("unstamped-ambiguous-merge-base");
    const common = commitFile(
      repo.dir,
      ".config/jig.yaml",
      "review:\n  skip_excluded_paths: []\n",
    );
    const left = commitFile(repo.dir, "feature.txt", "left\n");
    git(repo.dir, "checkout", "-q", "--detach", common);
    const right = commitFile(repo.dir, "feature.txt", "right\n");
    const base = git(
      repo.dir,
      "commit-tree",
      `${right}^{tree}`,
      "-p",
      left,
      "-p",
      right,
      "-m",
      "base merge",
    );
    const head = git(
      repo.dir,
      "commit-tree",
      `${left}^{tree}`,
      "-p",
      right,
      "-p",
      left,
      "-m",
      "head merge",
    );
    const fixture = {
      ...at({ dir: repo.dir, base, reviewed: left }, head),
      reviewedSha: null,
    };
    const result = await gate(repo.dir, fixture, null, {}, (dir) =>
      addUnstampedSkip(dir, head),
    );
    expectSpawnExit(result, 22);
    expect(result.state).toBe("REVIEW_SKIPPED");
    expect(result.reason).toContain("policy base could not be resolved");
  });

  it("does not trust exclusions introduced by the skipped head", async () => {
    const repo = pullRequestRepo("unstamped-head-policy");
    const head = commitFile(
      repo.dir,
      ".config/jig.yaml",
      "review:\n  skip_excluded_paths: [feature.txt, .config/jig.yaml]\n",
    );
    const fixture = { ...at(repo, head), reviewedSha: null };
    const result = await gate(repo.dir, fixture, null, {}, (dir) =>
      addUnstampedSkip(dir, head),
    );
    expectSpawnExit(result, 22);
    expect(result.state).toBe("REVIEW_SKIPPED");
    expect(result.reason).toContain(head);
  });

  it("stops when the skipped head's diff cannot be read", async () => {
    const repo = pullRequestRepo(
      "unstamped-unreadable-base",
      "review:\n  skip_excluded_paths: [feature.txt]\n",
    );
    const fixture = {
      ...at(repo, repo.merged, "de7e10ba5e222222222222222222222222222222"),
      reviewedSha: null,
    };
    const result = await gate(repo.dir, fixture, null, {}, (dir) =>
      addUnstampedSkip(dir, repo.merged),
    );
    expectSpawnExit(result, 22);
    expect(result.state).toBe("REVIEW_SKIPPED");
    expect(result.reason).toContain("skip notice");
    expect(result.reason).toContain(repo.merged);
  });

  it("awaits a review when an unstamped skip notice names an older head", async () => {
    const repo = pullRequestRepo("unstamped-stale-notice");
    const fixture = { ...at(repo, repo.merged), reviewedSha: null };
    const result = await gate(repo.dir, fixture, null, {}, (dir) =>
      addUnstampedSkip(dir, repo.reviewed),
    );
    expectSpawnExit(result, 4);
    expect(result.state).toBe("AWAITING_REVIEWER");
  });

  it("judges a base merge the reviewer skipped on the head it reviewed", async () => {
    const repo = pullRequestRepo("skipped-base-merge");
    const r = await gate(
      repo.dir,
      at(repo, repo.merged),
      skipNotice(repo.merged),
    );
    expectSpawnExit(r, 3);
    expect(r.state).toBe("CONVERGED");
    expect(r.reviewer.reviewedSha).toBe(repo.reviewed);
    expect(r.reviewer.reviewedShaSource).toBe("skip-notice");
    expect(r.reason).toContain(repo.reviewed);
    expect(r.reason).toContain("skipped");
  });

  it("stops as REVIEW_SKIPPED, naming the skip, when the skipped head changed the diff", async () => {
    const repo = pullRequestRepo("skipped-changed-diff");
    const r = await gate(
      repo.dir,
      at(repo, repo.changed),
      skipNotice(repo.changed),
    );
    expectSpawnExit(r, 22);
    expect(r.state).toBe("REVIEW_SKIPPED");
    expect(r.reason).toContain(repo.changed);
    expect(r.reason).toContain("empty diff");
  });

  it("stops as REVIEW_SKIPPED when the merge moved the change's lines", async () => {
    const repo = mergedHistory(
      "skipped-relocated-line",
      { "feature.txt": `${LINES.join("\n")}\n` },
      { "feature.txt": withNewAfter(2) },
      { "feature.txt": withNewAfter(6) },
    );
    const r = await gate(
      repo.dir,
      at(repo, repo.merged),
      skipNotice(repo.merged),
    );
    expectSpawnExit(r, 22);
    expect(r.state).toBe("REVIEW_SKIPPED");
  });

  it("stops as REVIEW_SKIPPED when a relative-diff setting would hide the moved lines", async () => {
    const repo = mergedHistory(
      "skipped-relative-diff",
      { "feature.txt": `${LINES.join("\n")}\n`, "sub/keep.txt": "kept\n" },
      { "feature.txt": withNewAfter(2) },
      { "feature.txt": withNewAfter(6) },
    );
    git(repo.dir, "config", "diff.relative", "true");
    const r = await gate(
      repo.dir,
      at(repo, repo.merged),
      skipNotice(repo.merged),
      { DRIVE_PR_WORKTREE: join(repo.dir, "sub") },
    );
    expectSpawnExit(r, 22);
    expect(r.state).toBe("REVIEW_SKIPPED");
  });

  it("stops as REVIEW_SKIPPED when the merge rewrote a binary file", async () => {
    const repo = mergedHistory(
      "skipped-binary-file",
      {},
      { "img.bin": new Uint8Array([0, 1, 2, 3, 0, 5]) },
      { "img.bin": new Uint8Array([0, 1, 9, 3, 0, 5]) },
    );
    const r = await gate(
      repo.dir,
      at(repo, repo.merged),
      skipNotice(repo.merged),
    );
    expectSpawnExit(r, 22);
    expect(r.state).toBe("REVIEW_SKIPPED");
  });

  it("stops as REVIEW_SKIPPED when the merge rewrote a binary file with bytes that are not UTF-8", async () => {
    const repo = mergedHistory(
      "skipped-binary-not-utf8",
      {},
      { "img.bin": new Uint8Array([0, 0x80, 0]) },
      { "img.bin": new Uint8Array([0, 0x81, 0]) },
    );
    const r = await gate(
      repo.dir,
      at(repo, repo.merged),
      skipNotice(repo.merged),
    );
    expectSpawnExit(r, 22);
    expect(r.state).toBe("REVIEW_SKIPPED");
  });

  it("stops as REVIEW_SKIPPED when the merge moved the change to an identical region", async () => {
    const repo = makeScratchRepo("skipped-identical-regions");
    const block = (edited: boolean) =>
      Array.from({ length: 7 }, (_, i) =>
        edited && i === 3 ? "# blk 3!" : `# blk ${i}`,
      );
    const filler = Array.from({ length: 8 }, (_, i) => `# filler ${i}`);
    const pre = Array.from({ length: 6 }, (_, i) => `# pre ${i}`);
    // Lines open with "#" so a hunk header names no function line.
    const file = (first: boolean, second: boolean, top = "") =>
      `${top}${[...pre, ...block(first), ...filler, ...block(second)].join("\n")}\n`;
    commitFile(repo.dir, "feature.txt", file(false, false));
    git(repo.dir, "checkout", "-q", "-b", "feature");
    const reviewed = commitFile(repo.dir, "feature.txt", file(true, false));
    git(repo.dir, "checkout", "-q", "main");
    const base = commitFile(
      repo.dir,
      "feature.txt",
      file(false, false, "# top\n"),
    );
    git(repo.dir, "checkout", "-q", "feature");
    git(repo.dir, "merge", "-q", "--no-ff", "--no-commit", "main");
    writeFileSync(join(repo.dir, "feature.txt"), file(false, true, "# top\n"));
    git(repo.dir, "add", "feature.txt");
    git(repo.dir, "commit", "-q", "--no-edit", "--no-verify");
    const merged = git(repo.dir, "rev-parse", "HEAD");
    const r = await gate(
      repo.dir,
      at({ dir: repo.dir, base, reviewed }, merged),
      skipNotice(merged),
    );
    expectSpawnExit(r, 22);
    expect(r.state).toBe("REVIEW_SKIPPED");
  });

  /** A base edit above the reviewed hunk shifts it; the merged head must still read as the reviewed diff. */
  async function convergesWhenBaseShiftsHunk(
    scratch: string,
    file: string,
    noprefix = false,
  ) {
    const repo = makeScratchRepo(scratch);
    if (noprefix) git(repo.dir, "config", "diff.noprefix", "true");
    const lines = Array.from({ length: 30 }, (_, i) => `row ${i}`);
    const text = (top: string, edited: boolean) =>
      `${top}${lines.map((l, i) => (edited && i === 25 ? "row 25!" : l)).join("\n")}\n`;
    commitFile(repo.dir, file, text("", false));
    git(repo.dir, "checkout", "-q", "-b", "feature");
    const reviewed = commitFile(repo.dir, file, text("", true));
    git(repo.dir, "checkout", "-q", "main");
    const base = commitFile(repo.dir, file, text("# top\n", false));
    git(repo.dir, "checkout", "-q", "feature");
    git(repo.dir, "merge", "-q", "--no-ff", "--no-edit", "main");
    const merged = git(repo.dir, "rev-parse", "HEAD");
    const r = await gate(
      repo.dir,
      at({ dir: repo.dir, base, reviewed }, merged),
      skipNotice(merged),
    );
    expectSpawnExit(r, 3);
    expect(r.state).toBe("CONVERGED");
  }

  it("converges when a base edit shifts a non-ASCII file's hunk under no-prefix diffs", () =>
    convergesWhenBaseShiftsHunk("skipped-non-ascii-path", "café.txt", true));

  it("converges when a base edit shifts a file's hunk when git quotes its name in the patch header", () =>
    convergesWhenBaseShiftsHunk("skipped-quoted-path", 'say "hi".txt'));

  it("reaches the skip notice when the reviewer's check-run itself concluded skipped", async () => {
    const repo = pullRequestRepo("skipped-check-run");
    const fixture = {
      ...at(repo, repo.merged),
      checkRuns: [{ ...REVIEWER_RUN, conclusion: "skipped" }],
    };
    const r = await gate(repo.dir, fixture, skipNotice(repo.merged));
    expectSpawnExit(r, 3);
    expect(r.state).toBe("CONVERGED");
    expect(r.reviewer.reviewedShaSource).toBe("skip-notice");
    const without = await gate(repo.dir, fixture, null);
    expect(without.state).toBe("AWAITING_REVIEWER");
  });

  it("stops as REVIEW_SKIPPED when the merge rewrote a file a diff attribute hides", async () => {
    const repo = mergedHistory(
      "skipped-diff-attribute",
      { ".gitattributes": "*.dat -diff\n" },
      { "notes.dat": "alpha\n" },
      { "notes.dat": "bravo\n" },
    );
    const r = await gate(
      repo.dir,
      at(repo, repo.merged),
      skipNotice(repo.merged),
    );
    expectSpawnExit(r, 22);
    expect(r.state).toBe("REVIEW_SKIPPED");
  });

  it("fetches a base this clone does not hold, then judges the skip", async () => {
    const repo = pullRequestRepo("skipped-fetched-base");
    const upstream = `${repo.dir}-upstream.git`;
    git(repo.dir, "clone", "-q", "--bare", repo.dir, upstream);
    const work = `${repo.dir}-work`;
    git(repo.dir, "clone", "-q", "--branch", "main", upstream, work);
    git(work, "config", "user.email", "probe@example.invalid");
    git(work, "config", "user.name", "drive-pr probe");
    git(work, "config", "commit.gpgsign", "false");
    git(work, "config", "core.hooksPath", "/dev/null");
    // The base moved on after the reviewer ran; this clone never fetched it.
    const advanced = commitFile(work, "later.txt", "a later base commit\n");
    git(work, "push", "-q", "origin", "main");
    git(repo.dir, "remote", "add", "origin", upstream);
    const r = await gate(
      repo.dir,
      at(repo, repo.merged, advanced),
      skipNotice(repo.merged),
    );
    expectSpawnExit(r, 3);
    expect(r.state).toBe("CONVERGED");
    expect(r.reviewer.reviewedShaSource).toBe("skip-notice");
  });

  it("is INDETERMINATE when a commit the comparison needs cannot be fetched", async () => {
    const repo = pullRequestRepo("skipped-unreadable-base");
    // A base commit this clone does not hold, and no remote to fetch it from.
    const r = await gate(
      repo.dir,
      at(repo, repo.merged, "de7e10ba5e222222222222222222222222222222"),
      skipNotice(repo.merged),
    );
    expectSpawnExit(r, 1);
    expect(r.state).toBe("INDETERMINATE");
    expect(r.reason).toContain("cannot be compared");
  });

  it("ignores a notice outside the reviewer's sticky comment", async () => {
    const repo = pullRequestRepo("skipped-spoofed-notice");
    const fixture = at(repo, repo.merged);
    const fromAPerson = await gate(repo.dir, fixture, null, {}, (dir) =>
      addComment(
        dir,
        "example-user-2",
        `<!-- ai-code-review -->\n${skipNotice(repo.merged)}\n<!-- ai-reviewed-sha: ${repo.reviewed} -->`,
      ),
    );
    expectSpawnExit(fromAPerson, 4);
    expect(fromAPerson.state).toBe("STALE_REVIEW");
    // The reviewer's own comment, marked sticky but carrying no SHA marker.
    const noStamp = await gate(repo.dir, fixture, null, {}, (dir) =>
      addComment(
        dir,
        "example-review[bot]",
        `<!-- ai-code-review -->\n${skipNotice(repo.merged)}`,
      ),
    );
    expectSpawnExit(noStamp, 4);
    expect(noStamp.state).toBe("STALE_REVIEW");
  });

  it("stays STALE_REVIEW when the notice's abbreviated head does not resolve", async () => {
    const repo = pullRequestRepo("skipped-unresolvable-notice");
    const r = await gate(
      repo.dir,
      at(repo, repo.merged),
      skipNotice("0123456789ab"),
    );
    expectSpawnExit(r, 4);
    expect(r.state).toBe("STALE_REVIEW");
  });

  it("changes nothing when the notice names a head other than the current one", async () => {
    const repo = pullRequestRepo("skipped-other-head");
    const fixture = at(repo, repo.merged);
    const without = await gate(repo.dir, fixture, null);
    expectSpawnExit(without, 4);
    expect(without.state).toBe("STALE_REVIEW");
    const r = await gate(repo.dir, fixture, skipNotice(repo.base));
    expectSpawnExit(r, 4);
    expect(r.state).toBe("STALE_REVIEW");
    expect(r.reason).toBe(without.reason);
  });

  it("fails closed when the stamp and the skip notice both name the current head", async () => {
    const repo = pullRequestRepo("skipped-and-stamped");
    const fixture = { ...at(repo, repo.merged), reviewedSha: repo.merged };
    const without = await gate(repo.dir, fixture, null);
    expect(without.state).not.toBe("STALE_REVIEW");
    const r = await gate(repo.dir, fixture, skipNotice(repo.merged));
    expectSpawnExit(r, 4);
    expect(r.state).toBe("STALE_REVIEW");
    expect(r.reason).toContain("contradictory");
  });

  it("fails closed when an unresolvable abbreviated notice is a prefix of the stamped head", async () => {
    const repo = pullRequestRepo("skipped-prefix-unresolvable");
    const fixture = { ...at(repo, repo.merged), reviewedSha: repo.merged };
    const r = await gate(
      repo.dir,
      fixture,
      skipNotice(repo.merged.slice(0, 12)),
      {
        DRIVE_PR_WORKTREE: mkdtempSync(join(tmpdir(), "jig-no-git-")),
      },
    );
    expectSpawnExit(r, 4);
    expect(r.state).toBe("STALE_REVIEW");
    expect(r.reason).toContain("contradictory");
  });

  it("reads the notice under the marker the repository configures", async () => {
    const repo = pullRequestRepo("skipped-custom-marker");
    const fixture = at(repo, repo.merged);
    const env = { DRIVE_PR_SKIP_NOTICE_MARKER: "example-skip" };
    const r = await gate(
      repo.dir,
      fixture,
      skipNotice(repo.merged, "example-skip"),
      env,
    );
    expectSpawnExit(r, 3);
    expect(r.state).toBe("CONVERGED");
    const other = await gate(repo.dir, fixture, skipNotice(repo.merged), env);
    expectSpawnExit(other, 4);
    expect(other.state).toBe("STALE_REVIEW");
  });

  /** Attach a local bare `origin` matching the fixture PR repo (`example-org/example-repo`) and `develop` base. */
  function withPolicyRemote(
    repoDir: string,
    developCommit: string,
  ): { remote: string; env: Record<string, string> } {
    const remote = `${repoDir}-remote.git`;
    git(repoDir, "init", "-q", "--bare", remote);
    git(repoDir, "push", "-q", remote, `${developCommit}:refs/heads/develop`);
    git(remote, "symbolic-ref", "HEAD", "refs/heads/develop");
    git(repoDir, "remote", "add", "origin", remote);
    git(repoDir, "update-ref", "refs/remotes/origin/develop", developCommit);
    git(
      repoDir,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/develop",
    );
    const fakeGitDir = `${repoDir}-gitbin`;
    mkdirSync(fakeGitDir, { recursive: true });
    writeFakeProgram(
      join(fakeGitDir, "git"),
      `#!/usr/bin/env sh
if [ "\${*#*remote get-url }" = "origin" ]; then
  echo https://github.com/example-org/example-repo.git
  exit 0
fi
exec "${realGitForShell()}" "$@"
`,
    );
    return {
      remote,
      env: {
        PATH: `${fakeGitDir}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
      },
    };
  }

  it("converges an unstamped current-head skip when the refreshed base excludes every changed path", async () => {
    const repo = pullRequestRepo(
      "unstamped-remote-excluded",
      "review:\n  skip_excluded_paths: [feature.txt]\n",
    );
    const { env } = withPolicyRemote(repo.dir, repo.base);
    const fixture = { ...at(repo, repo.merged), reviewedSha: null };
    const standalone = await gate(repo.dir, fixture, null, env, (dir) =>
      addUnstampedSkip(dir, repo.merged),
    );
    expectSpawnExit(standalone, 3);
    expect(standalone.state).toBe("CONVERGED");
    expect(standalone.reviewer.reviewedSha).toBe(repo.merged);
    expect(standalone.reviewer.reviewedShaSource).toBe("skip-notice");

    const driven = await gate(
      repo.dir,
      fixture,
      null,
      { ...env, DRIVE_PR_TARGET: "999", DRIVE_PR_POLICY_BASE: repo.base },
      (dir) => addUnstampedSkip(dir, repo.merged),
    );
    expectSpawnExit(driven, 3);
    expect(driven.state).toBe("CONVERGED");
    expect(driven.reviewer.reviewedShaSource).toBe("skip-notice");
  });

  it("refreshes the reviewed policy on a driver poll when the base revokes a skip exclusion", async () => {
    const repo = pullRequestRepo(
      "unstamped-revoked-driver-poll",
      "review:\n  skip_excluded_paths: [feature.txt]\n",
    );
    const { remote, env } = withPolicyRemote(repo.dir, repo.base);
    git(repo.dir, "checkout", "-q", "main");
    const revoked = commitFile(
      repo.dir,
      ".config/jig.yaml",
      "review:\n  skip_excluded_paths: []\n",
    );
    git(repo.dir, "push", "-q", remote, `${revoked}:refs/heads/develop`);

    // Driver exported the older policy base before the poll began; the
    // evaluation now observes the newer base where the exclusion was revoked.
    const fixture = { ...at(repo, repo.merged, revoked), reviewedSha: null };
    const r = await gate(
      repo.dir,
      fixture,
      null,
      { ...env, DRIVE_PR_TARGET: "999", DRIVE_PR_POLICY_BASE: repo.base },
      (dir) => addUnstampedSkip(dir, repo.merged),
    );
    expectSpawnExit(r, 22);
    expect(r.state).toBe("REVIEW_SKIPPED");
    expect(r.reason).toContain("outside review.skip_excluded_paths");

    // Even when the PR snapshot lags on the older base commit, refreshing the
    // remote base enforces the revocation.
    const lagging = await gate(
      repo.dir,
      { ...at(repo, repo.merged, repo.base), reviewedSha: null },
      null,
      { ...env, DRIVE_PR_TARGET: "999", DRIVE_PR_POLICY_BASE: repo.base },
      (dir) => addUnstampedSkip(dir, repo.merged),
    );
    expectSpawnExit(lagging, 22);
    expect(lagging.state).toBe("REVIEW_SKIPPED");
    expect(lagging.reason).toContain("outside review.skip_excluded_paths");
  });

  it("refuses to certify an unstamped skip when the refreshed policy does not cover the evaluated base commit", async () => {
    const repo = pullRequestRepo(
      "unstamped-stale-remote-base",
      "review:\n  skip_excluded_paths: [feature.txt]\n",
    );
    // Remote still points at the older base with the exclusion, while the
    // evaluated PR snapshot already names the newer commit that revoked it.
    const { env } = withPolicyRemote(repo.dir, repo.base);
    git(repo.dir, "checkout", "-q", "main");
    const newer = commitFile(
      repo.dir,
      ".config/jig.yaml",
      "review:\n  skip_excluded_paths: []\n",
    );
    const fixture = { ...at(repo, repo.merged, newer), reviewedSha: null };
    const r = await gate(repo.dir, fixture, null, env, (dir) =>
      addUnstampedSkip(dir, repo.merged),
    );
    expectSpawnExit(r, 22);
    expect(r.state).toBe("REVIEW_SKIPPED");
    expect(r.reason).toContain("does not cover the evaluated base commit");
  });
});
