/**
 * verification-fit.test.ts — the recorder's refusal and provenance contract.
 *
 * The script's value is entirely in what it refuses: a verdict with no
 * evidence, no area, or no plan; a vocabulary drift on verdict/area/testbox
 * outcome; a fabricated or unrelated plan; a credential-bearing remote URL
 *. So the tests pin the refusals as hard as the
 * happy path, and the happy path asserts the record carries the plan extract
 * (seedAreas, testboxDecision, requiredBy) the calibration pass
 * clusters on, plus the required `area` field.
 *
 * Two provenance checks need a real git history to exercise honestly: "base
 * is a real commit" and "base is an ancestor of HEAD". Baking fixed SHAs into
 * this file would rot as the repo's history moves, so a small throwaway git
 * repo is built in a tmpdir for exactly those cases (and for the credential
 * sanitization test, which needs a controllable `origin` remote).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "verification-fit.ts");

// An area the fixture catalog (written in beforeAll and named by the fixture
// overlay's drive.change_areas_catalog) declares, used wherever a test needs a
// VALID --area and isn't itself testing area validation.
const REAL_AREA = "skill-scripts";
let overlayFile: string;

let workDir: string;
let baseRepo: string; // throwaway repo runScript spawns in by default — see beforeAll
let logFile: string;
let repoBase: string; // a real commit in THIS repo, ancestor of its own HEAD
let PLAN: string; // built in beforeAll, after repoBase is known — see plan()

// A git hook (this suite runs under the `drive-pr-selftest` pre-commit hook)
// EXPORTS GIT_DIR/GIT_WORK_TREE/etc pointing at the REAL repository, and those
// override `cwd` — a throwaway `git init` here would re-initialise the CALLER'S
// worktree instead of the tmpdir, corrupting it (measured: this exact class hit
// an earlier change via a different suite; see feedback_git_hook_env_leak_corrupts_-
// conductor_worktrees). Scrub every git-repo-location env var before every
// call, not just once — the point is that no invocation of `git` in this
// describe block ever inherits ambient repo location, regardless of caller.
//
// Prefix-scrubbed rather than enumerated (coderabbitai, PR #4114): a
// hand-maintained list of location vars is one counterexample behind
// permanently — this one carried four of the seven and the reviewer had to
// name the missing three. `GIT_` covers every location var git has now or
// adds later, it is what drive-pr.test.ts, drives.test.ts and
// resolve-review-comments/__tests__/scripts.test.ts already do, and nothing
// here needs a GIT_* var preserved (a suite that must SET GIT_AUTHOR_DATE,
// like defect-escape.test.ts, keeps a narrower list for exactly that reason).
function scrubbedGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || v === undefined) continue;
    env[k] = v;
  }
  return env;
}

function execGit(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: scrubbedGitEnv(),
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "verification-fit-"));
  logFile = join(workDir, "nested", "verification-fit.jsonl");
  const catalogFile = join(workDir, "catalog.yaml");
  writeFileSync(
    catalogFile,
    `areas:\n  ${REAL_AREA}:\n    paths: ["scripts/**"]\n  docs:\n    paths: ["docs/**"]\n`,
  );
  overlayFile = join(workDir, "overlay.yaml");
  writeFileSync(
    overlayFile,
    `drive:\n  change_areas_catalog: ${JSON.stringify(catalogFile)}\n`,
  );
  // Anchor the default plan to a THROWAWAY repo, not the enclosing checkout:
  // resolving `repoBase` from the repository this suite happens to live in
  // made the whole suite depend on being spawned inside a git worktree —
  // false on the remote gates host and on a Blacksmith Testbox, where the
  // synced checkout has no `.git` at all. The script under test
  // validates base/HEAD/branch/origin against the repo at its CWD, so a
  // scratch repo with one commit and a clean origin URL exercises exactly
  // the same paths, hermetically — the same construction the throwaway-repo
  // describe below already uses for its non-ancestor and credential cases.
  baseRepo = join(workDir, "base-repo");
  mkdirSync(baseRepo, { recursive: true });
  execGit(["init", "-q"], baseRepo);
  execGit(["config", "user.email", "test@example.com"], baseRepo);
  execGit(["config", "user.name", "Test"], baseRepo);
  execGit(["checkout", "-q", "-b", "main"], baseRepo);
  execGit(
    [
      "remote",
      "add",
      "origin",
      "https://github.com/example-org/example-repo.git",
    ],
    baseRepo,
  );
  writeFileSync(join(baseRepo, "root.txt"), "root");
  execGit(["add", "."], baseRepo);
  execGit(["commit", "-q", "-m", "root"], baseRepo);
  repoBase = execGit(["rev-parse", "HEAD"], baseRepo);
  // Built here, not at module scope: `plan()` reads `repoBase`, and module-level
  // code runs before ANY `beforeAll` — a `const PLAN = plan()` at top level would
  // capture `repoBase` while it's still `undefined`, which `JSON.stringify` then
  // silently drops from the object entirely (measured: every PLAN-using test that
  // expects success failed this way on the first pass of this suite).
  PLAN = plan();
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function plan(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: "cumulative",
    base: repoBase,
    empty: false,
    files: ["a.ts", "b.ts", "c.md"],
    seedAreas: ["claude-skill-scripts", "docs"],
    validation: {
      profiles: ["docs-only", "full"],
      localChecks: ["pnpm format"],
      testbox: {
        required: true,
        reason: "area-opt-in",
        requiredBy: [{ area: "claude-skill-scripts", files: ["a.ts", "b.ts"] }],
      },
    },
    testboxDecision: {
      required: true,
      planRequired: true,
      incrementalRequired: null,
      decayed: false,
      requiredBy: [{ area: "claude-skill-scripts", files: ["a.ts", "b.ts"] }],
      verifiedSha: null,
      note: null,
    },
    ...overrides,
  });
}

async function runScript(
  args: string[],
  stdin: string,
  opts: { cwd?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    // Defaulting to the scratch `baseRepo` (never this process's own cwd)
    // keeps the suite runnable where the enclosing checkout is not a git
    // worktree at all — remote gates host, Blacksmith Testbox.
    cwd: opts.cwd ?? baseRepo,
    // Scrubbed, not raw `process.env` (coderabbitai, PR #4114): the script
    // under test resolves its actor identity with `git rev-parse`, and a
    // hook-exported GIT_DIR overrides `cwd` — so the leak this suite already
    // guards its OWN `git` calls against reached the subject of the test
    // instead, selecting the enclosing worktree rather than `baseRepo`.
    env: {
      ...scrubbedGitEnv(),
      GROUNDWORK_VERIFICATION_FIT_LOG: logFile,
      GROUNDWORK_OVERLAY: overlayFile,
      // Point drive-state at an empty dir so `rounds` resolves without touching
      // any real per-clone drive state.
      DRIVE_PR_STATE_DIR: workDir,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("verification-fit.ts argument refusals", () => {
  it("refuses a missing verdict", async () => {
    const r = await runScript(
      ["123", "--area", REAL_AREA, "--evidence", "x"],
      PLAN,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--verdict is required");
  });

  it("refuses a verdict outside the closed vocabulary", async () => {
    const r = await runScript(
      [
        "123",
        "--verdict",
        "too-strict",
        "--area",
        REAL_AREA,
        "--evidence",
        "x",
      ],
      PLAN,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--verdict must be one of");
  });

  it("refuses a missing area", async () => {
    const r = await runScript(
      ["123", "--verdict", "over-strict", "--evidence", "x"],
      PLAN,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--area is required");
  });

  it("refuses an area outside the catalog vocabulary", async () => {
    const r = await runScript(
      [
        "123",
        "--verdict",
        "over-strict",
        "--area",
        "not-a-real-area",
        "--evidence",
        "x",
      ],
      PLAN,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(
      "--area 'not-a-real-area' is not a known catalog area",
    );
  });

  it("refuses empty evidence", async () => {
    const r = await runScript(
      [
        "123",
        "--verdict",
        "over-strict",
        "--area",
        REAL_AREA,
        "--evidence",
        "  ",
      ],
      PLAN,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--evidence is required");
  });

  it("refuses a testbox outcome outside the closed vocabulary", async () => {
    const r = await runScript(
      [
        "123",
        "--verdict",
        "over-strict",
        "--area",
        REAL_AREA,
        "--evidence",
        "x",
        "--testbox-outcome",
        "green",
      ],
      PLAN,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--testbox-outcome must be one of");
  });

  it("refuses a non-numeric PR", async () => {
    const r = await runScript(
      [
        "abc",
        "--verdict",
        "over-strict",
        "--area",
        REAL_AREA,
        "--evidence",
        "x",
      ],
      PLAN,
    );
    expect(r.exitCode).toBe(2);
  });

  it("refuses PR 0", async () => {
    const r = await runScript(
      ["0", "--verdict", "over-strict", "--area", REAL_AREA, "--evidence", "x"],
      PLAN,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("PR number must be a positive integer");
  });

  it("refuses a PR number past Number.MAX_SAFE_INTEGER", async () => {
    const r = await runScript(
      [
        "99999999999999999999",
        "--verdict",
        "over-strict",
        "--area",
        REAL_AREA,
        "--evidence",
        "x",
      ],
      PLAN,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("PR number must be a positive integer");
  });

  it("canonicalizes a leading-zero PR number", async () => {
    const r = await runScript(
      [
        "00042",
        "--verdict",
        "proportionate",
        "--area",
        REAL_AREA,
        "--evidence",
        "x",
      ],
      PLAN,
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).pr).toBe(42);
  });
});

describe("verification-fit.ts provenance refusals", () => {
  it("refuses an empty stdin — a verdict without its provoking plan", async () => {
    const r = await runScript(
      [
        "123",
        "--verdict",
        "over-strict",
        "--area",
        REAL_AREA,
        "--evidence",
        "x",
      ],
      "",
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("no plan on stdin");
  });

  it("refuses non-JSON stdin", async () => {
    const r = await runScript(
      [
        "123",
        "--verdict",
        "over-strict",
        "--area",
        REAL_AREA,
        "--evidence",
        "x",
      ],
      "Testbox: REQUIRED",
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not valid JSON");
  });

  it.each(["null", "true", "42", "[]", '"a string"'])(
    "refuses non-object JSON stdin: %s",
    async (body) => {
      const r = await runScript(
        [
          "123",
          "--verdict",
          "over-strict",
          "--area",
          REAL_AREA,
          "--evidence",
          "x",
        ],
        body,
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("not a JSON object");
    },
  );

  it("refuses a plan missing required string fields", async () => {
    const r = await runScript(
      [
        "123",
        "--verdict",
        "over-strict",
        "--area",
        REAL_AREA,
        "--evidence",
        "x",
      ],
      JSON.stringify({
        files: [],
        validation: { testbox: { required: false } },
      }),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("'mode' is missing or not a non-empty string");
  });

  it("refuses a plan whose validation.testbox.required is not a boolean", async () => {
    const r = await runScript(
      [
        "123",
        "--verdict",
        "over-strict",
        "--area",
        REAL_AREA,
        "--evidence",
        "x",
      ],
      plan({ validation: { testbox: { required: null } } }),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("validation.testbox.required is not a boolean");
  });

  it("refuses a base that is not a commit in this clone", async () => {
    const r = await runScript(
      [
        "123",
        "--verdict",
        "over-strict",
        "--area",
        REAL_AREA,
        "--evidence",
        "x",
      ],
      plan({ base: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("is not a commit in this clone");
  });
});

describe("verification-fit.ts against a throwaway repo (non-ancestor base, credential sanitization)", () => {
  let tempRepo: string;
  let sideSha: string;
  let mainSha: string;

  beforeAll(() => {
    tempRepo = mkdtempSync(join(tmpdir(), "verification-fit-repo-"));
    execGit(["init", "-q"], tempRepo);
    execGit(["config", "user.email", "test@example.com"], tempRepo);
    execGit(["config", "user.name", "Test"], tempRepo);
    execGit(["checkout", "-q", "-b", "main"], tempRepo);
    execGit(
      [
        "remote",
        "add",
        "origin",
        "https://x-access-token:supersecrettoken@github.com/example-org/example-repo.git",
      ],
      tempRepo,
    );
    Bun.write(join(tempRepo, "root.txt"), "root");
    execGit(["add", "."], tempRepo);
    execGit(["commit", "-q", "-m", "root"], tempRepo);
    const rootSha = execGit(["rev-parse", "HEAD"], tempRepo);

    // A commit on a divergent branch — exists in the repo, but is NOT an
    // ancestor of main's tip.
    execGit(["checkout", "-q", "-b", "side", rootSha], tempRepo);
    Bun.write(join(tempRepo, "side.txt"), "side");
    execGit(["add", "."], tempRepo);
    execGit(["commit", "-q", "-m", "side"], tempRepo);
    sideSha = execGit(["rev-parse", "HEAD"], tempRepo);

    // Back to main, one more commit so main's tip differs from the root.
    execGit(["checkout", "-q", "main"], tempRepo);
    Bun.write(join(tempRepo, "main2.txt"), "main2");
    execGit(["add", "."], tempRepo);
    execGit(["commit", "-q", "-m", "main2"], tempRepo);
    mainSha = execGit(["rev-parse", "HEAD"], tempRepo);
  });

  afterAll(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  it("refuses a base that is a real commit but not an ancestor of HEAD", async () => {
    const r = await runScript(
      [
        "123",
        "--verdict",
        "over-strict",
        "--area",
        REAL_AREA,
        "--evidence",
        "x",
      ],
      plan({ base: sideSha }),
      { cwd: tempRepo },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("is not an ancestor of HEAD");
  });

  it("strips embedded credentials from the recorded origin URL", async () => {
    const r = await runScript(
      [
        "123",
        "--verdict",
        "proportionate",
        "--area",
        REAL_AREA,
        "--evidence",
        "x",
      ],
      plan({ base: mainSha }),
      { cwd: tempRepo },
    );
    expect(r.exitCode).toBe(0);
    const record = JSON.parse(r.stdout);
    expect(record.origin).toBe(
      "https://github.com/example-org/example-repo.git",
    );
    expect(record.origin).not.toContain("supersecrettoken");
    expect(record.origin).not.toContain("x-access-token");
  });
});

describe("verification-fit.ts record", () => {
  it("appends one JSONL record carrying the plan extract and area as provenance", async () => {
    const r = await runScript(
      [
        "4032",
        "--verdict",
        "over-strict",
        "--area",
        REAL_AREA,
        "--evidence",
        "box re-ran the full suite for a docs-adjacent script edit",
        "--suggest",
        "demote claude-skill-scripts to profile: scoped",
        "--testbox-outcome",
        "pass",
        "--testbox-minutes",
        "18",
      ],
      PLAN,
    );
    expect(r.exitCode).toBe(0);

    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    const record = JSON.parse(lines.at(-1) ?? "");
    expect(record.v).toBe(1);
    expect(record.pr).toBe(4032);
    expect(record.verdict).toBe("over-strict");
    expect(record.area).toBe(REAL_AREA);
    expect(record.suggest).toBe(
      "demote claude-skill-scripts to profile: scoped",
    );
    expect(record.testboxOutcome).toBe("pass");
    expect(record.testboxMinutes).toBe(18);
    // The provenance the Calibrate pass clusters on — and the bulky command
    // strings deliberately dropped.
    expect(record.plan.seedAreas).toEqual(["claude-skill-scripts", "docs"]);
    expect(record.plan.fileCount).toBe(3);
    expect(record.plan.testbox.requiredBy).toEqual([
      { area: "claude-skill-scripts", files: ["a.ts", "b.ts"] },
    ]);
    expect(record.plan.testboxDecision.decayed).toBe(false);
    expect(record.plan).not.toHaveProperty("localChecks");
    // Echoed to stdout so the round report can quote it verbatim.
    expect(JSON.parse(r.stdout).verdict).toBe("over-strict");
  });

  it("accumulates — a second record appends rather than overwrites", async () => {
    const before = readFileSync(logFile, "utf8").trim().split("\n").length;
    const r = await runScript(
      [
        "4032",
        "--verdict",
        "proportionate",
        "--area",
        REAL_AREA,
        "--evidence",
        "box caught a CI-only env bug",
      ],
      PLAN,
    );
    expect(r.exitCode).toBe(0);
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(before + 1);
    expect(JSON.parse(lines.at(-1) ?? "").verdict).toBe("proportionate");
  });
});
