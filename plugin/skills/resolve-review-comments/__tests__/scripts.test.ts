/**
 * scripts.test.ts — the resolve-review-comments script surface after its
 * TypeScript port (from await-round.sh / converge.sh / reply-to-thread.sh /
 * lib/gh-deadline.sh).
 *
 * Two halves, mirroring drive-pr's own suite:
 *
 *   - Unit tests over `reply-to-thread.ts`'s outcome grammar — the exact
 *     predicate `qualifyingOutcome()` in drive-pr's reconcile mirrors, so a
 *     drift here corrupts the harvested reviewer-scoring sample.
 *   - Scripted probes that run the entry scripts against a STUBBED `gh` and
 *     assert the exit code they reach. One probe per loop-contract exit code,
 *     because the loop contract is the one decision an unattended resolve
 *     loop cannot get wrong — when it may STOP (exit 3), and when it must
 *     not.
 *
 * The probes are subprocess integration tests. Each spawns a script that
 * itself spawns the stub `gh` (and await-round.ts spawns its sibling
 * list-unresolved-threads.ts), which can exceed bun's 5s default per-test
 * budget on a loaded machine — run this file with `--timeout 30000`
 * (`pnpm skill-scripts:test` does).
 *
 * The thread writers have their own file (scripts-thread-writes.test.ts), and
 * so do `run()`'s cancellation and kill paths (scripts-proc.test.ts); the stub
 * `gh` and the fixture helpers all three share are in scripts-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "../../../../lib/guarded-git-spawn.ts";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { run } from "../scripts/lib/proc.ts";
import {
  skillsParentIsIntact,
  validateOutcomeBody,
} from "../scripts/reply-to-thread.ts";
import {
  SCRIPTS,
  HEAD_A,
  HEAD_B,
  tmpRoot,
  binDir,
  repoDir,
  gitCleanEnv,
  type Fixture,
  check,
  thread,
  writeFixture,
  runScript,
  roundsFile,
  useStubForge,
} from "./scripts-harness.ts";

// ── Outcome grammar (unit) ──────────────────────────────────────────────────

describe("reply-to-thread.ts outcome grammar", () => {
  const VALID: ReadonlyArray<readonly [string, string]> = [
    ["the house style", "**accepted** — added the guard in abc1234."],
    [
      "a rejected outcome",
      "**rejected** — the table is not soft-deletable (ADR-0053).",
    ],
    ["the hyphenated token", "**wont-fix** — declined per the triage rubric."],
    ["a deferred outcome", "**deferred** — filed TASK."],
    ["a moot outcome", "**moot** — the branch was deleted in abc1234."],
    ["a tab boundary", "**accepted**\tfixed in abc1234."],
    ["multiple spaces", "**accepted**   fixed."],
    ["a bare-word reason", "**accepted** x"],
    ["a digits-only reason", "**deferred** 4031"],
    ["free-form later lines", "**accepted** — fixed.\n\n```diff\n+ x\n```\n"],
    // A terminal \r is a line terminator, not content — routine when a reply
    // is read from a CRLF file on Windows, which this script now runs on.
    ["a CRLF first line", "**accepted** — fixed.\r\nmore.\r\n"],
    ["a CRLF-terminated single line", "**accepted** — fixed.\r\n"],
  ];
  for (const [label, body] of VALID) {
    it(`accepts ${label}`, () => {
      expect({ body, ok: validateOutcomeBody(body) }).toEqual({
        body,
        ok: true,
      });
    });
  }

  const INVALID: ReadonlyArray<readonly [string, string]> = [
    // A bare token classifies the thread while explaining nothing.
    ["a bare token", "**accepted**"],
    // No token boundary: a parser reads the token as `accepted**oops`.
    ["a missing boundary", "**accepted**oops"],
    // An em dash alone is a separator, not a reason (TASK).
    ["a separator-only reason", "**accepted** — "],
    ["an em-dash-only reason", "**accepted** —"],
    // U+2003 EM SPACE: the boundary is ASCII space/tab exactly — the bash
    // original's `[[:space:]]` matched this under a UTF-8 locale and not
    // under C, so the SAME body passed on one host and failed on another
    //. The port keeps the strict reading.
    ["a Unicode-space boundary", "**accepted** fixed."],
    ["an uppercase token", "**Accepted** — fixed."],
    ["a synonym", "**fixed** — done."],
    ["an unhyphenated wont-fix", "**wontfix** — declined."],
    ["a leading greeting", "Thanks! **accepted** — fixed."],
    ["leading whitespace", " **accepted** — fixed."],
    ["a second-line token", "context first\n**accepted** — fixed."],
    ["an unbolded token", "accepted — fixed."],
  ];
  for (const [label, body] of INVALID) {
    it(`rejects ${label}`, () => {
      expect({ body, ok: validateOutcomeBody(body) }).toEqual({
        body,
        ok: false,
      });
    });
  }
});

useStubForge();

// ── await-round.ts: the loop contract ───────────────────────────────────────

it.skipIf(process.platform === "win32")(
  "fake gh requires structured fields for pr checks",
  () => {
    const result = spawnSync(join(binDir, "gh"), ["pr", "checks", "42"], {
      env: gitCleanEnv(),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "pr checks requires --json name,bucket,state",
    );
  },
);

describe.skipIf(process.platform === "win32")(
  "await-round.ts loop contract",
  () => {
    it("exit 5: a PR that is not OPEN abandons the loop before anything else", () => {
      const fix = writeFixture({ state: "MERGED" });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect({ code: r.code, stderr: r.stderr }).toEqual({
        code: 5,
        stderr: expect.stringContaining("abandoning the loop"),
      });
    });

    it("exit 1: an unreadable PR state is never settled", () => {
      const fix = writeFixture({ stateUnreadable: true });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`cannot read state of PR #${fix.pr}`);
    });

    it("exit 4 under --once: a pending check is not settled", () => {
      const fix = writeFixture({
        checks: [check("AI review (shadow)", "pending", "IN_PROGRESS")],
      });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain("--once given, not waiting");
    });

    it("exit 4 under --once: `gh pr checks` exit 8 is authoritative pending", () => {
      const fix = writeFixture({ checks: { exit: 8 } });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(4);
    });

    it("exit 1 under --once: an unreadable check set is never settled", () => {
      const fix = writeFixture({ checks: { exit: 1 } });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("refusing to guess");
    });

    it("exit 7: a failed reviewer check may never have posted its findings", () => {
      const fix = writeFixture({
        checks: [check("AI review (shadow)", "fail", "COMPLETED")],
      });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(7);
      expect(r.stderr).toContain("FAILED");
    });

    it("exit 2: an explicit --job-pattern needs declared required coverage", () => {
      const fix = writeFixture({
        checks: [check("build", "pass", "COMPLETED")],
      });
      const r = runScript(
        "await-round.ts",
        [fix.pr, "--once", "--job-pattern", "no-such-check"],
        fix,
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("requires review.required_checks");
    });

    for (const scenario of [
      {
        label: "mixed success/skip",
        required: ["AI review", "CodeRabbit"],
        checks: [
          check("AI review", "pass", "SUCCESS"),
          check("CodeRabbit", "skipping", "SKIPPED"),
        ],
        code: 7,
      },
      {
        label: "missing required member",
        required: ["AI review", "CodeRabbit"],
        checks: [check("AI review", "pass", "SUCCESS")],
        code: 4,
      },
      {
        label: "all required checks absent despite --no-ci",
        required: ["AI review", "CodeRabbit"],
        checks: [],
        code: 4,
      },
      {
        label: "all required members complete",
        required: ["AI review", "CodeRabbit"],
        checks: [
          check("AI review", "pass", "SUCCESS"),
          check("CodeRabbit", "pass", "SUCCESS"),
        ],
        code: 3,
      },
      {
        label: "required member pending",
        required: ["AI review", "CodeRabbit"],
        checks: [
          check("AI review", "pass", "SUCCESS"),
          check("CodeRabbit", "pending", "IN_PROGRESS"),
        ],
        code: 4,
      },
      {
        label: "required member neutral",
        required: ["AI review", "CodeRabbit"],
        checks: [
          check("AI review", "pass", "SUCCESS"),
          check("CodeRabbit", "skipping", "NEUTRAL"),
        ],
        code: 3,
      },
      {
        label: "retired optional arm skipped",
        required: ["CodeRabbit"],
        checks: [
          check("AI review", "skipping", "SKIPPED"),
          check("CodeRabbit", "pass", "SUCCESS"),
        ],
        code: 3,
      },
      {
        label: "retired optional arm absent",
        required: ["CodeRabbit"],
        checks: [check("CodeRabbit", "pass", "SUCCESS")],
        code: 3,
      },
      {
        label: "optional arm still running",
        required: ["CodeRabbit"],
        checks: [
          check("AI review", "pending", "IN_PROGRESS"),
          check("CodeRabbit", "pass", "SUCCESS"),
        ],
        code: 4,
      },
      {
        label: "duplicate name cannot hide skipped required check",
        required: ["CodeRabbit"],
        checks: [
          check("CodeRabbit", "pass", "SUCCESS"),
          check("CodeRabbit", "skipping", "SKIPPED"),
        ],
        code: 7,
      },
    ]) {
      it(`explicit coverage: ${scenario.label}`, () => {
        const fix = writeFixture({ checks: scenario.checks });
        const overlay = join(fix.dir, "overlay.json");
        writeFileSync(
          overlay,
          JSON.stringify({ review: { required_checks: scenario.required } }),
        );
        const result = runScript(
          "await-round.ts",
          [
            fix.pr,
            "--once",
            "--no-ci",
            "--job-pattern",
            "AI review|CodeRabbit",
          ],
          fix,
          { env: { JIG_OVERLAY: overlay } },
        );
        expect({ code: result.code, stderr: result.stderr }).toEqual({
          code: scenario.code,
          stderr: expect.any(String),
        });
        if (scenario.code !== 3)
          expect(result.stderr).not.toContain("converged:");
      });
    }

    // Required coverage must not switch off failure detection elsewhere, and
    // an observed terminal failure outranks missing coverage and a pending exit.
    for (const scenario of [
      {
        label: "failed optional reviewer beside satisfied required one",
        required: ["CodeRabbit"],
        checks: [
          check("AI review", "fail", "FAILURE"),
          check("CodeRabbit", "pass", "SUCCESS"),
        ],
        code: 7,
      },
      {
        label: "failed required member while another is missing",
        required: ["AI review", "CodeRabbit"],
        checks: [check("AI review", "fail", "FAILURE")],
        code: 7,
      },
      {
        label: "cancelled required member while another is missing",
        required: ["AI review", "CodeRabbit"],
        checks: [check("AI review", "cancel", "CANCELLED")],
        code: 7,
      },
    ]) {
      it(`required coverage keeps failure detection: ${scenario.label}`, () => {
        const fix = writeFixture({ checks: scenario.checks });
        const overlay = join(fix.dir, "overlay.json");
        writeFileSync(
          overlay,
          JSON.stringify({ review: { required_checks: scenario.required } }),
        );
        const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
          env: { JIG_OVERLAY: overlay },
        });
        expect(r.code).toBe(scenario.code);
        expect(r.stderr).not.toContain("converged:");
      });
    }

    it("exit 7: a skipped required reviewer outranks a gh exit-8 pending answer", () => {
      const fix = writeFixture({
        checks: {
          exit: 8,
          body: [
            check("CodeRabbit", "skipping", "SKIPPED"),
            check("build", "pending", "IN_PROGRESS"),
          ],
        },
      });
      const overlay = join(fix.dir, "overlay.json");
      writeFileSync(
        overlay,
        JSON.stringify({ review: { required_checks: ["CodeRabbit"] } }),
      );
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: { JIG_OVERLAY: overlay },
      });
      expect(r.code).toBe(7);
    });

    it("the missing-coverage diagnostic names only the absent checks", () => {
      const fix = writeFixture({
        checks: [check("AI review", "pass", "SUCCESS")],
      });
      const overlay = join(fix.dir, "overlay.json");
      writeFileSync(
        overlay,
        JSON.stringify({
          review: { required_checks: ["AI review", "CodeRabbit"] },
        }),
      );
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: { JIG_OVERLAY: overlay },
      });
      expect(r.code).toBe(4);
      expect(r.stderr).toMatch(/waiting for: CodeRabbit$/m);
    });

    it("required custom check names work without a job pattern", () => {
      const fix = writeFixture({
        checks: [check("custom-check", "pass", "SUCCESS")],
      });
      const overlay = join(fix.dir, "overlay.json");
      writeFileSync(
        overlay,
        JSON.stringify({ review: { required_checks: ["custom-check"] } }),
      );
      const result = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: { JIG_OVERLAY: overlay },
      });
      expect(result.code).toBe(3);
    });

    it("a job pattern cannot exclude a required member", () => {
      const fix = writeFixture({});
      const overlay = join(fix.dir, "overlay.json");
      writeFileSync(
        overlay,
        JSON.stringify({ review: { required_checks: ["CodeRabbit"] } }),
      );
      const result = runScript(
        "await-round.ts",
        [fix.pr, "--once", "--job-pattern", "AI review"],
        fix,
        { env: { JIG_OVERLAY: overlay } },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("excluded by --job-pattern");
    });

    it("exit 4 under --once: checks exist but none is reviewer-shaped — not settled", () => {
      const fix = writeFixture({
        checks: [check("build", "pass", "COMPLETED")],
      });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain("no reviewer-shaped check");
    });

    it("exit 4 under --once: a permanently-SKIPPED reviewer arm attests nothing", () => {
      // The CI-fallback "AI review" arm is gated off (vars.AI_REVIEW_CI_ARM
      // unset); counting it as a veto would report `failed` forever, counting it
      // as settled would converge over an unreviewed round. It is neither.
      const fix = writeFixture({
        checks: [check("AI review", "skipping", "SKIPPED")],
      });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain("no reviewer-shaped check");
    });

    it("a NEUTRAL reviewer conclusion is a completion state, not a failure to report", () => {
      const fix = writeFixture({
        checks: [check("AI review (shadow)", "fail", "NEUTRAL")],
      });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(3);
    });

    it("exit 0: settled with unresolved threads is a ready round", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("round ready: 1 unresolved thread(s)");
    });

    it("exit 3: settled with zero unresolved threads is converged", () => {
      const fix = writeFixture({
        threads: [thread("PRRT_a", { resolved: true })],
      });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("converged: 0 unresolved thread(s)");
    });

    // TASK: zero threads is not zero findings. await-round.ts asks
    // /drive-pr's own summary-findings.ts (an optional sibling) before it
    // reports convergence, and exits 8 on anything unaddressed.
    describe("summary-only findings (TASK)", () => {
      function convergedFixture(): Fixture {
        return writeFixture({
          threads: [thread("PRRT_a", { resolved: true })],
        });
      }

      describe("--once-budget-sec", () => {
        it("usage error: not digits-only", () => {
          const fix = convergedFixture();
          const r = runScript(
            "await-round.ts",
            [fix.pr, "--once", "--once-budget-sec", "abc"],
            fix,
          );
          expect(r.code).toBe(2);
          expect(r.stderr).toContain("--once-budget-sec");
        });

        for (const zero of ["0", "00"]) {
          it(`usage error: rejects the zero spelling '${zero}'`, () => {
            const fix = convergedFixture();
            const r = runScript(
              "await-round.ts",
              [fix.pr, "--once", "--once-budget-sec", zero],
              fix,
            );
            expect(r.code).toBe(2);
          });
        }

        it("usage error: rejects a value whose *1000 overflows setTimeout", () => {
          const fix = convergedFixture();
          const r = runScript(
            "await-round.ts",
            [fix.pr, "--once", "--once-budget-sec", "999999999999"],
            fix,
          );
          expect(r.code).toBe(2);
        });

        it("converges normally when the declared budget comfortably covers the call", () => {
          const fix = convergedFixture();
          const r = runScript(
            "await-round.ts",
            [fix.pr, "--once", "--once-budget-sec", "1000"],
            fix,
          );
          expect(r.code).toBe(3);
        });

        it("refuses (exit 1) when too little of the declared budget remains", () => {
          const fix = convergedFixture();
          // SUMMARY_ONCE_MARGIN_SEC + SUMMARY_ONCE_MIN_TIMEOUT_SEC is 20s, so a
          // 10s declared budget refuses regardless of how little time this
          // fast, fake-`gh`-backed run actually takes.
          const r = runWithSibling(
            "await-round.ts",
            [fix.pr, "--once", "--once-budget-sec", "10"],
            fix,
            { "summary-findings.ts": 'console.log("[]");' },
          );
          expect(r.code).toBe(1);
          expect(r.stderr).toContain(
            "too little of the declared --once-budget-sec",
          );
          expect(r.stderr).not.toContain("converged:");
        });

        it("is inert without --once, even declared with an unmeetable value", () => {
          const fix = convergedFixture();
          const r = runScript(
            "await-round.ts",
            [fix.pr, "--once-budget-sec", "10"],
            fix,
          );
          expect(r.code).toBe(3);
        });
      });

      /** await-round.ts run from a copied install whose `/drive-pr` sibling is
       * shaped by `sibling`. */
      function runFromInstall(
        name: string,
        sibling:
          | { kind: "absent" }
          | { kind: "script"; source: string }
          | { kind: "broken-symlink" }
          | { kind: "scripts-dir-only" }
          | { kind: "root-only" }
          | { kind: "skills-removed-mid-run" }
          | { kind: "drive-pr-is-a-file" },
      ) {
        const fix = convergedFixture();
        const skills = join(tmpRoot, `skills-summary-${name}`);
        const rrc = join(skills, "resolve-review-comments", "scripts");
        mkdirSync(join(skills, "resolve-review-comments"), { recursive: true });
        cpSync(SCRIPTS, rrc, { recursive: true });
        const dp = join(skills, "drive-pr");
        if (sibling.kind === "script") {
          mkdirSync(join(dp, "scripts"), { recursive: true });
          writeFileSync(
            join(dp, "scripts", "summary-findings.ts"),
            sibling.source,
          );
        } else if (sibling.kind === "skills-removed-mid-run") {
          writeFileSync(join(fix.dir, "rm-on-threads"), skills);
        } else if (sibling.kind === "root-only") {
          mkdirSync(dp, { recursive: true });
        } else if (sibling.kind === "scripts-dir-only") {
          mkdirSync(join(dp, "scripts"), { recursive: true });
        } else if (sibling.kind === "drive-pr-is-a-file") {
          // A corrupted install: `lstat(drive-pr/scripts)` fails ENOTDIR, not
          // ENOENT — not proof that /drive-pr is absent.
          writeFileSync(dp, "not a directory\n");
        } else if (sibling.kind === "broken-symlink") {
          mkdirSync(dp, { recursive: true });
          symlinkSync(join(dp, "scripts-does-not-exist"), join(dp, "scripts"));
        }
        const r = spawnSync(
          process.execPath,
          [join(rrc, "await-round.ts"), fix.pr, "--once"],
          {
            encoding: "utf8",
            cwd: repoDir,
            env: {
              ...gitCleanEnv(),
              PATH: `${binDir}${delimiter}${process.env.PATH}`,
              RRC_FIX: fix.dir,
              GH_CALL_TIMEOUT: "20",
            },
          },
        );
        return { code: r.status, stderr: r.stderr };
      }

      const report = (unaddressed: unknown[]) =>
        `process.stdout.write(${JSON.stringify(JSON.stringify({ total: unaddressed.length, unaddressed }))});`;

      it("exit 8 when the sibling reports an unaddressed finding, naming its fingerprint", () => {
        const r = runFromInstall("outstanding", {
          kind: "script",
          source: report([{ fingerprint: "abc123", path: "a.ts" }]),
        });
        expect(r.code).toBe(8);
        expect(r.stderr).toContain("abc123");
      });

      it("exit 3 when the sibling reports none unaddressed", () => {
        const r = runFromInstall("clean", {
          kind: "script",
          source: report([]),
        });
        expect(r.code).toBe(3);
      });

      it("exit 3 in a STANDALONE install, saying the check was skipped", () => {
        const r = runFromInstall("standalone", { kind: "absent" });
        expect(r.code).toBe(3);
        expect(r.stderr).toContain(
          "no drive-pr skill was found for this repository",
        );
      });

      it("exit 1 when the sibling fails", () => {
        const r = runFromInstall("fails", {
          kind: "script",
          source: "process.exit(1);",
        });
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("refusing to report converged");
      });

      it("exit 1 when the sibling prints a clean report but still exits non-zero", () => {
        const r = runFromInstall("clean-but-fails", {
          kind: "script",
          source: `${report([])} process.exitCode = 1;`,
        });
        expect(r.code).toBe(1);
      });

      it("exit 1, never the standalone skip, when the probe fails with anything but ENOENT", () => {
        const r = runFromInstall("enotdir", { kind: "drive-pr-is-a-file" });
        expect(r.code).toBe(1);
        expect(r.stderr).not.toContain(
          "no drive-pr skill was found for this repository",
        );
      });

      it("exit 1 when the sibling answers in an unusable shape", () => {
        const r = runFromInstall("malformed", {
          kind: "script",
          source: report([{ path: "a.ts" }]),
        });
        expect(r.code).toBe(1);
      });

      it("exit 1, never the standalone skip, on a dangling /drive-pr scripts symlink", () => {
        const r = runFromInstall("dangling", { kind: "broken-symlink" });
        expect(r.code).toBe(1);
        expect(r.stderr).not.toContain(
          "no drive-pr skill was found for this repository",
        );
      });

      it("exit 1, never the standalone skip, when the skills directory disappears mid-run", () => {
        const r = runFromInstall("gone", { kind: "skills-removed-mid-run" });
        expect(r.code).toBe(1);
        expect(r.stderr).not.toContain(
          "no drive-pr skill was found for this repository",
        );
      });

      it("exit 1, never the standalone skip, on a /drive-pr root with no scripts/ directory", () => {
        const r = runFromInstall("root-only", { kind: "root-only" });
        expect(r.code).toBe(1);
        expect(r.stderr).not.toContain(
          "no drive-pr skill was found for this repository",
        );
      });

      it("exit 1, never the standalone skip, on a partial install missing the script", () => {
        const r = runFromInstall("partial", { kind: "scripts-dir-only" });
        expect(r.code).toBe(1);
      });
    });

    it("--bots-only scopes the count to bot-authored threads", () => {
      const fix = writeFixture({
        threads: [thread("PRRT_h", { bot: false })],
      });
      // The human thread holds the unscoped count above zero…
      expect(runScript("await-round.ts", [fix.pr, "--once"], fix).code).toBe(0);
      // …and the scoped count converges past it.
      expect(
        runScript("await-round.ts", [fix.pr, "--once", "--bots-only"], fix)
          .code,
      ).toBe(3);
    });

    it("counts a round per distinct head, not per invocation", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(readFileSync(roundsFile(fix.pr), "utf8").trim()).toBe("1");
      // A retry on the same head is a driver retry, not a reviewer round.
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(readFileSync(roundsFile(fix.pr), "utf8").trim()).toBe("1");
      // A new push IS a new round.
      writeFileSync(join(fix.dir, "head"), `${HEAD_B}\n`);
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(readFileSync(roundsFile(fix.pr), "utf8").trim()).toBe("2");
    });

    // The counter and its head key are two separate writes, so the ORDER decides
    // which way an interruption between them falls. Head first: the round is
    // lost, which only delays the decline-only cutoff. Count first — the
    // previous order — left a valid count paired with a stale head, so the next
    // call re-counted the SAME round and could arm the cutoff early.
    //
    // Reproducing the intermediate state by hand proves nothing: the script
    // behaves identically given either state, and the fix changes which state is
    // REACHABLE. So make the second write fail instead — a directory where the
    // counter file belongs — and read which file exists afterwards. Under the
    // old order the counter write is first and throws, leaving no `.head`;
    // under this one the head is already on disk when it throws.
    it("writes the head key before the count, so an interrupted bump cannot strand one", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      mkdirSync(roundsFile(fix.pr));
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(existsSync(`${roundsFile(fix.pr)}.head`)).toBe(true);
      expect(readFileSync(`${roundsFile(fix.pr)}.head`, "utf8").trim()).toBe(
        HEAD_A,
      );
    });

    // An unresolved head used to increment anyway AND leave `.head` unwritten,
    // so the dedup above could not fire and every retry counted again — a
    // retried round 3 arriving as round 4. Harmless for the advisory nudge,
    // not harmless now that the ordinal decides disposition.
    it("does not count a round when the head cannot be resolved", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      // One real round first, so the probe distinguishes "refused to bump" from
      // "never bumped at all".
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(readFileSync(roundsFile(fix.pr), "utf8").trim()).toBe("1");
      rmSync(join(fix.dir, "head"), { force: true });
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(readFileSync(roundsFile(fix.pr), "utf8").trim()).toBe("1");
    });

    it("--no-count inspects without counting", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      runScript("await-round.ts", [fix.pr, "--once", "--no-count"], fix);
      expect(existsSync(roundsFile(fix.pr))).toBe(false);
    });

    it("nudges structural escalation on every counted round past the threshold", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: { REFLECT_THRESHOLD: "0" },
      });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("stop patching variants");
    });

    it("an empty REFLECT_THRESHOLD takes the documented default", () => {
      // `?? '3'` keeps `''`, which isDigits rejects — so a variable exported
      // empty by optional templating turned a documented default into a usage
      // exit 2 in both entry points.
      // Default 3 means one counted round must NOT nudge; '0' above proves the
      // nudge still fires when the threshold really is 0, so this is not merely
      // asserting silence.
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: { REFLECT_THRESHOLD: "" },
      });
      expect({
        code: r.code,
        nudged: r.stderr.includes("stop patching variants"),
      }).toEqual({ code: 0, nudged: false });

      // converge.ts validates the same variable up front, and regressed the same
      // way. Empty must reach the round loop rather than fail as a usage error.
      const cfix = writeFixture({ threads: [] });
      const c = runScript(
        "converge.ts",
        [cfix.pr, "--", process.execPath, "-e", "process.exit(0)", cfix.pr],
        cfix,
        { env: { REFLECT_THRESHOLD: "" } },
      );
      expect(c.code).toBe(0);

      // A genuine typo still refuses, in both.
      expect(
        runScript("await-round.ts", [fix.pr, "--once"], fix, {
          env: { REFLECT_THRESHOLD: "x" },
        }).code,
      ).toBe(2);
      expect(
        runScript(
          "converge.ts",
          [cfix.pr, "--", process.execPath, "-e", "process.exit(0)", cfix.pr],
          cfix,
          { env: { REFLECT_THRESHOLD: "x" } },
        ).code,
      ).toBe(2);
    });

    it("prompts /reflect at wind-down when the session exceeded the threshold, and resets the counter", () => {
      const fix = writeFixture({ threads: [] });
      writeFileSync(roundsFile(fix.pr), "5\n");
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("converged after 5 rounds");
      expect(r.stderr).toContain("/reflect");
      expect(existsSync(roundsFile(fix.pr))).toBe(false);
    });

    it("a converged --no-count probe neither erases the counter nor fires the prompt", () => {
      const fix = writeFixture({ threads: [] });
      writeFileSync(roundsFile(fix.pr), "5\n");
      const r = runScript(
        "await-round.ts",
        [fix.pr, "--once", "--no-count"],
        fix,
      );
      expect(r.code).toBe(3);
      expect(r.stderr).not.toContain("/reflect");
      expect(readFileSync(roundsFile(fix.pr), "utf8").trim()).toBe("5");
      rmSync(roundsFile(fix.pr), { force: true });
      rmSync(`${roundsFile(fix.pr)}.head`, { force: true });
    });

    it("exit 2: usage errors are usage errors", () => {
      const fix = writeFixture({});
      for (const args of [
        ["--interval", "2"],
        ["--interval"],
        ["--interval", "2147484", "--timeout", "2147484"],
        ["--interval", "9".repeat(400), "--timeout", "9".repeat(400)],
        ["--timeout", "x"],
        ["--frobnicate"],
        ["--timeout", "5", "--interval", "30"],
        ["--job-pattern", "("],
      ]) {
        const r = runScript("await-round.ts", [fix.pr, ...args], fix);
        expect({ args, code: r.code }).toEqual({ args, code: 2 });
      }
    });
  },
);

// ── converge.ts: loop control over await-round.ts ───────────────────────────

describe.skipIf(process.platform === "win32")(
  "converge.ts loop control",
  () => {
    it("exit 0 with no pass run on an already-converged PR", () => {
      const fix = writeFixture({ threads: [] });
      const marker = join(fix.dir, "pass-ran");
      const r = runScript(
        "converge.ts",
        [
          fix.pr,
          "--",
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
          fix.pr,
        ],
        fix,
      );
      expect({ code: r.code, passRan: existsSync(marker) }).toEqual({
        code: 0,
        passRan: false,
      });
      expect(r.stderr).toContain("converged after 0 round(s)");
    });

    it("runs the pass argv directly (no shell) and converges when its fix empties the thread list", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      // The pass "resolves the thread" by rewriting the fixture — the next
      // await-round evaluation then reads zero unresolved threads.
      const emptied = JSON.stringify([
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        },
      ]);
      const passJs = `require('node:fs').writeFileSync(require('node:path').join(process.env.RRC_FIX, 'threads.json'), ${JSON.stringify(emptied)})`;
      const r = runScript(
        "converge.ts",
        [fix.pr, "--", process.execPath, "-e", passJs, fix.pr],
        fix,
      );
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("--- round 1/10");
      expect(r.stderr).toContain("converged after 1 round(s)");
    });

    it("exit 1 when the pass fails, without resolving further", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript(
        "converge.ts",
        [fix.pr, "--", process.execPath, "-e", "process.exit(3)", fix.pr],
        fix,
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("pass failed on round 1");
    });

    it("exit 6 at --max-rounds when the pass never converges the PR", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript(
        "converge.ts",
        [
          fix.pr,
          "--max-rounds",
          "2",
          "--",
          process.execPath,
          "-e",
          "process.exit(0)",
          fix.pr,
        ],
        fix,
      );
      expect(r.code).toBe(6);
      expect(r.stderr).toContain("hit --max-rounds (2)");
    });

    it("exit 5 propagated verbatim: a PR that merges mid-loop stops the loop", () => {
      const fix = writeFixture({
        state: "MERGED",
        threads: [thread("PRRT_a")],
      });
      const r = runScript(
        "converge.ts",
        [fix.pr, "--", process.execPath, "-e", "process.exit(0)", fix.pr],
        fix,
      );
      expect(r.code).toBe(5);
    });

    it("refuses a pass command that does not name the explicit PR (exact token, not substring)", () => {
      const fix = writeFixture({});
      // '12' must not satisfy a driver waiting on '123…' — the probe PR number
      // appears only as a substring of a longer number in the pass argv.
      const r = runScript(
        "converge.ts",
        [fix.pr, "--", "codex", "exec", `/resolve-review-comments ${fix.pr}9`],
        fix,
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("names no PR");
    });

    it("refuses --bots-only when the pass command is not also scoped", () => {
      const fix = writeFixture({});
      const r = runScript(
        "converge.ts",
        [
          fix.pr,
          "--bots-only",
          "--",
          "codex",
          "exec",
          `/resolve-review-comments ${fix.pr}`,
        ],
        fix,
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--bots-only");
    });

    it("--dry-run inspects a ready round without invoking the pass or counting it", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const marker = join(fix.dir, "pass-ran");
      const r = runScript(
        "converge.ts",
        [
          fix.pr,
          "--dry-run",
          "--",
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
          fix.pr,
        ],
        fix,
      );
      expect({ code: r.code, passRan: existsSync(marker) }).toEqual({
        code: 0,
        passRan: false,
      });
      expect(r.stderr).toContain("(dry-run) would run:");
      expect(existsSync(roundsFile(fix.pr))).toBe(false);
    });

    it("exports the target PR and bot scope out-of-band to the pass", () => {
      // The two argv tests above are typo-catchers: they inspect an opaque pass
      // command, where `... "/resolve-review-comments 999" --label 123` names
      // 123 while targeting 999, and `... do not use --bots-only` names the flag
      // while asking for the opposite. $RRC_TARGET_PR / $RRC_BOTS_ONLY are the
      // channel list-unresolved-threads.ts actually enforces, so a pass that
      // does not receive them has no guarantee at all.
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const seen = join(fix.dir, "env.json");
      const passJs = `require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ target: process.env.RRC_TARGET_PR, bots: process.env.RRC_BOTS_ONLY }))`;
      runScript(
        "converge.ts",
        [
          fix.pr,
          "--bots-only",
          "--max-rounds",
          "1",
          "--",
          process.execPath,
          "-e",
          passJs,
          `${fix.pr} --bots-only`,
        ],
        fix,
      );
      expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({
        target: fix.pr,
        bots: "1",
      });
    });

    it("rejects unsafe --max-rounds before running a pass or querying GitHub", () => {
      for (const maxRounds of [
        "9".repeat(400),
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        const fix = writeFixture({ threads: [thread("PRRT_bounded")] });
        const marker = join(fix.dir, "pass-ran");
        const r = runScript(
          "converge.ts",
          [
            fix.pr,
            "--max-rounds",
            maxRounds,
            "--",
            process.execPath,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
            fix.pr,
          ],
          fix,
        );
        expect(r.code).toBe(2);
        expect(r.stderr).toContain(
          "--max-rounds takes a whole number within the safe integer range",
        );
        expect(existsSync(marker)).toBe(false);
        for (const log of [
          "pr-view-calls.log",
          "pr-checks-calls.log",
          "rest-calls.log",
        ])
          expect(existsSync(join(fix.dir, log))).toBe(false);
      }
    });

    it("accepts small and maximum-safe --max-rounds values", () => {
      for (const maxRounds of ["1", String(Number.MAX_SAFE_INTEGER)]) {
        const fix = writeFixture({ threads: [] });
        const r = runScript(
          "converge.ts",
          [fix.pr, "--max-rounds", maxRounds, "--", "unused-pass", fix.pr],
          fix,
        );
        expect(r.code).toBe(0);
        expect(r.stderr).toContain("converged after 0 round(s)");
      }
    });

    it("exit 2: a missing pass command is a usage error", () => {
      const fix = writeFixture({});
      expect(runScript("converge.ts", [fix.pr], fix).code).toBe(2);
      expect(
        runScript("converge.ts", [fix.pr, "--max-rounds", "x", "--", "x"], fix)
          .code,
      ).toBe(2);
    });
  },
);

// ── run(): a failed SPAWN is not an exit code (TASK) ────────────────────

describe("run() distinguishes a failed spawn from a child that exits 127", () => {
  // `run()` never rejects — a spawn error resolves as 127 with the error text
  // on stderr, because every bash call site read a missing command and a failed
  // one the same way. That conflation is load-bearing for exit-status callers
  // and wrong for the one caller that must know whether ANYTHING RAN:
  // converge.ts releases /drive-pr's tier-3 lease only when a pass could have
  // taken a claim, and keyed on `code` it released on a `codex` binary missing
  // from PATH — stripping a live sibling resolver's record.
  //
  // The pair below is the whole point: a `code === 127` test passes the first
  // probe and FAILS the second, so it cannot stand in for the field.

  it("reports spawnFailed when the binary does not exist", async () => {
    const r = await run([join(tmpRoot, "no-such-binary-doc6893"), "arg"]);
    expect({ code: r.code, spawnFailed: r.spawnFailed }).toEqual({
      code: 127,
      spawnFailed: true,
    });
  });

  it("does NOT report spawnFailed when a real child exits 127 itself", async () => {
    const r = await run([process.execPath, "-e", "process.exit(127)"]);
    expect({ code: r.code, spawnFailed: r.spawnFailed }).toEqual({
      code: 127,
      spawnFailed: false,
    });
  });

  it("reports spawnFailed false for an ordinary successful child", async () => {
    const r = await run([process.execPath, "-e", "process.exit(0)"]);
    expect({ code: r.code, spawnFailed: r.spawnFailed }).toEqual({
      code: 0,
      spawnFailed: false,
    });
  });
});

// ── converge.ts: the sessionless-lease release on loop exit (TASK) ──────

// ── list-unresolved-threads.ts: the enumeration chokepoint ──────────────────

describe.skipIf(process.platform === "win32")(
  "list-unresolved-threads.ts enforces converge.ts out-of-band scope",
  () => {
    const ids = (stdout: string): string[] =>
      stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { threadId: string }).threadId);

    it("refuses to enumerate a PR other than $RRC_TARGET_PR", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript("list-unresolved-threads.ts", [], fix, {
        env: { RRC_TARGET_PR: `${fix.pr}9` },
      });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`the run is working PR #${fix.pr}9`);
    });

    it("$RRC_BOTS_ONLY scopes the enumeration even when argv does not", () => {
      // The whole point: converge.ts cannot prove an opaque pass passes
      // --bots-only, so the pass is never handed a human thread's id in the
      // first place. reply-to-thread.ts and resolve-thread.ts both need one, and
      // this is the only script that produces them.
      const fix = writeFixture({
        threads: [thread("PRRT_bot"), thread("PRRT_human", { bot: false })],
      });
      expect(
        ids(runScript("list-unresolved-threads.ts", [], fix).stdout),
      ).toEqual(["PRRT_bot", "PRRT_human"]);
      const scoped = runScript("list-unresolved-threads.ts", [], fix, {
        env: { RRC_BOTS_ONLY: "1" },
      });
      expect({ code: scoped.code, ids: ids(scoped.stdout) }).toEqual({
        code: 0,
        ids: ["PRRT_bot"],
      });
    });

    // `self-inflicted.ts` reads `diffSide` off this stream to tell a LEFT-side
    // anchor (numbering the pre-image, not HEAD) from a RIGHT-side one — see
    // that script's own header. Propagated
    // through verbatim, same as `startLine`/`isOutdated`.
    it("propagates diffSide verbatim, including the null default", () => {
      const sides = (stdout: string) =>
        stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { diffSide: string | null }).diffSide);
      const fix = writeFixture({
        threads: [
          thread("PRRT_left", { diffSide: "LEFT" }),
          thread("PRRT_right", { diffSide: "RIGHT" }),
          thread("PRRT_none"),
        ],
      });
      expect(
        sides(runScript("list-unresolved-threads.ts", [], fix).stdout),
      ).toEqual(["LEFT", "RIGHT", null]);
    });

    // `self-inflicted.ts`'s `labelRecord` reads `startDiffSide` off this stream
    // to tell a genuinely multi-line range whose start straddles a hunk
    // boundary (`startDiffSide` differing from `diffSide`) from one that does
    // not — GitHub allows the two to differ, and `diffSide` alone describes
    // only the range's END. Propagated through
    // verbatim, same as `diffSide` itself.
    it("propagates startDiffSide verbatim, including the null default", () => {
      const startSides = (stdout: string) =>
        stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(
            (l) =>
              (JSON.parse(l) as { startDiffSide: string | null }).startDiffSide,
          );
      const fix = writeFixture({
        threads: [
          thread("PRRT_straddle", { diffSide: "RIGHT", startDiffSide: "LEFT" }),
          thread("PRRT_wholly_right", {
            diffSide: "RIGHT",
            startDiffSide: "RIGHT",
          }),
          thread("PRRT_none"),
        ],
      });
      expect(
        startSides(runScript("list-unresolved-threads.ts", [], fix).stdout),
      ).toEqual(["LEFT", "RIGHT", null]);
    });

    it("an agreeing $RRC_TARGET_PR, and an empty one, both pass through", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      for (const env of [{ RRC_TARGET_PR: fix.pr }, {}] as Record<
        string,
        string
      >[]) {
        const r = runScript("list-unresolved-threads.ts", [], fix, { env });
        expect({ env, code: r.code, ids: ids(r.stdout) }).toEqual({
          env,
          code: 0,
          ids: ["PRRT_a"],
        });
      }
    });

    // The reversal check (triage rubric § Contradictory findings) needs the
    // prior round's outcome, which survives ONLY on the resolved thread — the
    // held batch is cleared the moment the thread resolves. Default output must
    // stay unresolved-only, because await-round.ts/converge.ts read open work
    // off this stream's line count.
    it("--include-resolved widens to resolved threads; default does not", () => {
      const lines = (stdout: string) =>
        stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const t = JSON.parse(l) as {
              threadId: string;
              isResolved: boolean;
            };
            return { threadId: t.threadId, isResolved: t.isResolved };
          });
      const fix = writeFixture({
        threads: [thread("PRRT_open"), thread("PRRT_done", { resolved: true })],
      });

      const dflt = runScript("list-unresolved-threads.ts", [], fix);
      expect({ code: dflt.code, lines: lines(dflt.stdout) }).toEqual({
        code: 0,
        lines: [{ threadId: "PRRT_open", isResolved: false }],
      });

      const wide = runScript(
        "list-unresolved-threads.ts",
        ["--include-resolved"],
        fix,
      );
      expect({ code: wide.code, lines: lines(wide.stdout) }).toEqual({
        code: 0,
        lines: [
          { threadId: "PRRT_open", isResolved: false },
          { threadId: "PRRT_done", isResolved: true },
        ],
      });
    });

    // A bot finding can reverse an accepted HUMAN outcome, and under the
    // continuous --bots-only flow the reversal check would never see it: the
    // bots-only filter dropped the resolved human thread entirely. History must
    // pass through; the id must not, since --bots-only exists so a pass is never
    // handed an actionable human thread id.
    it("--bots-only keeps resolved human threads as id-redacted history", () => {
      // The OUTCOME reply is what the reversal check reads, and it is never the
      // thread's first comment — asserting comments[0] alone would pass while a
      // regression emitted only the finding and dropped the outcome
      //. So the fixture carries a trusted outcome and
      // the shape asserts EVERY body, plus every reply-capable handle.
      const OUTCOME = "**accepted** — prior human decision on this construct";
      // The OPEN human thread carries a trusted outcome too, and the assertions
      // below check EVERY one of its bodies. Without it the fixture held only
      // the initial finding, so a regression emitting `comments.slice(0, 1)`
      // for unresolved history alone would drop the outcome the reversal check
      // reads and still leave this test green.
      const OPEN_OUTCOME = "**wont-fix** — human decision, thread left open";
      const shape = (stdout: string) =>
        stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const t = JSON.parse(l) as {
              threadId: string | null;
              redacted?: boolean;
              isResolved: boolean;
              url: string | null;
              comments: { body: string | null; url: string | null }[];
            };
            return {
              threadId: t.threadId,
              redacted: t.redacted ?? false,
              isResolved: t.isResolved,
              url: t.url,
              bodies: t.comments.map((c) => c.body),
              commentUrls: t.comments.map((c) => c.url),
            };
          });
      const fix = writeFixture({
        threads: [
          thread("PRRT_bot_open"),
          thread("PRRT_human_open", {
            bot: false,
            replies: [{ association: "MEMBER", body: OPEN_OUTCOME }],
          }),
          thread("PRRT_human_done", {
            bot: false,
            resolved: true,
            replies: [
              { association: "MEMBER", body: OUTCOME },
              {
                association: "MEMBER",
                // a cross-link: the id here is a REST reply handle and must not
                // survive redaction, or the record is still postable
                body: "see https://github.com/acme/widgets/pull/1#discussion_r999",
              },
            ],
          }),
          thread("PRRT_bot_done", { resolved: true }),
        ],
      });

      // Without --include-resolved, --bots-only is unchanged: bots, unresolved.
      const narrow = runScript(
        "list-unresolved-threads.ts",
        ["--bots-only"],
        fix,
      );
      expect(shape(narrow.stdout).map((t) => t.threadId)).toEqual([
        "PRRT_bot_open",
      ]);

      const history = runScript(
        "list-unresolved-threads.ts",
        ["--bots-only", "--include-resolved"],
        fix,
      );
      const botOpenUrl =
        "https://github.com/acme/widgets/pull/1#discussion_PRRT_bot_open";
      const botDoneUrl =
        "https://github.com/acme/widgets/pull/1#discussion_PRRT_bot_done";
      expect({ code: history.code, lines: shape(history.stdout) }).toEqual({
        code: 0,
        lines: [
          {
            threadId: "PRRT_bot_open",
            redacted: false,
            isResolved: false,
            url: botOpenUrl,
            bodies: ["a finding"],
            commentUrls: [botOpenUrl],
          },
          // an OPEN human thread is history too — a human may deliberately leave
          // an acted-on thread open, and its outcome is what a later bot finding
          // could reverse. Redacted, so it is never actionable; but ALL of its
          // bodies survive, the outcome reply included.
          {
            threadId: null,
            redacted: true,
            isResolved: false,
            url: null,
            bodies: ["a finding", OPEN_OUTCOME],
            commentUrls: [null, null],
          },
          // the resolved human thread's OUTCOME is visible; nothing postable
          // survives —
          // not the GraphQL id, not the thread url, not a comment permalink
          // (whose #discussion_r fragment is a REST reply id).
          {
            threadId: null,
            redacted: true,
            isResolved: true,
            url: null,
            bodies: [
              "a finding",
              OUTCOME,
              "see https://github.com/acme/widgets/pull/1#discussion_r[redacted]",
            ],
            commentUrls: [null, null, null],
          },
          {
            threadId: "PRRT_bot_done",
            redacted: false,
            isResolved: true,
            url: botDoneUrl,
            bodies: ["a finding"],
            commentUrls: [botDoneUrl],
          },
        ],
      });
      // …and the open human thread is history too — redacted, never actionable.
      // A human may deliberately leave an acted-on thread open, and its outcome
      // is exactly what a later bot finding might reverse.
      const openHuman = shape(history.stdout).filter(
        (t) => t.threadId === null && !t.isResolved,
      );
      expect(openHuman).toEqual([
        {
          threadId: null,
          redacted: true,
          isResolved: false,
          url: null,
          bodies: ["a finding", OPEN_OUTCOME],
          commentUrls: [null, null],
        },
      ]);
      expect(history.stdout).not.toContain("PRRT_human_open");
    });

    // The reversal check reads outcome tokens out of this stream, and a thread
    // is world-commentable — so every comment must carry the server-computed
    // `authorAssociation` the rubric gates on. Without it per comment, a
    // spoofed `**accepted**` from an outside author is indistinguishable from a
    // real prior outcome.
    it("carries authorAssociation on every comment of a resolved thread", () => {
      const fix = writeFixture({
        threads: [
          thread("PRRT_hist", {
            resolved: true,
            replies: [
              {
                association: "NONE",
                body: "**accepted** — spoofed by an outsider",
              },
              {
                association: "MEMBER",
                body: "**rejected** — the real outcome",
              },
            ],
          }),
        ],
      });
      const r = runScript(
        "list-unresolved-threads.ts",
        ["--include-resolved"],
        fix,
      );
      const rec = JSON.parse(r.stdout.trim()) as {
        comments: { authorAssociation: string | null; body: string | null }[];
      };
      expect(
        rec.comments.map((c) => [c.authorAssociation, c.body?.slice(0, 12)]),
      ).toEqual([
        ["NONE", "a finding"],
        ["NONE", "**accepted**"],
        ["MEMBER", "**rejected**"],
      ]);
    });
  },
);

// ── The drive lease fences the POST, not only the state write (TASK) ────

describe("no script mutates anything at import time", () => {
  // `unresolve-thread.ts` ran its GraphQL mutation at module scope, so merely
  // IMPORTING it posted — and the sweep below, which spawns every script with
  // `--help`, was safe only because it stubs `gh`.
  // The whole family gates side effects behind `import.meta.main`; this asserts it
  // rather than trusting the harness.
  const entries = readdirSync(SCRIPTS).filter((f) => f.endsWith(".ts"));

  it("sweeps a non-empty script set", () => {
    expect(entries).toContain("unresolve-thread.ts");
    expect(entries).toContain("resolve-thread.ts");
  });

  for (const rel of entries) {
    it(`importing ${rel} spawns no gh`, () => {
      // A `gh` on PATH that RECORDS its invocation rather than one that fails:
      // an import-time call must be visible as a file, not inferred from an
      // exit code the import may swallow.
      const probeDir = mkdtempSync(join(tmpdir(), "rrc-import-"));
      const marker = join(probeDir, "gh-was-called");
      writeFileSync(
        join(probeDir, process.platform === "win32" ? "gh.cmd" : "gh"),
        process.platform === "win32"
          ? `@echo called > "${marker}"\r\n@exit /b 1\r\n`
          : `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`,
        { mode: 0o755 },
      );
      const r = spawnSync(
        process.execPath,
        ["-e", `import(${JSON.stringify(join(SCRIPTS, rel))})`],
        {
          encoding: "utf8",
          cwd: repoDir,
          input: "",
          env: {
            ...gitCleanEnv(),
            PATH: `${probeDir}${delimiter}${process.env.PATH}`,
            GH_CALL_TIMEOUT: "1",
          },
        },
      );
      expect({ rel, ghCalled: existsSync(marker) }).toEqual({
        rel,
        ghCalled: false,
      });
      // An import that throws would satisfy the assertion vacuously.
      expect({ rel, stderr: r.stderr.slice(0, 400) }).toEqual({
        rel,
        stderr: "",
      });
      rmSync(probeDir, { recursive: true, force: true });
    });
  }
});

// ── await-round.ts: polling cost (TASK) ─────────────────────────────────
//
// Every `gh pr view` / `gh pr checks` is a GraphQL call against a per-token
// hourly bucket. These probes read what the loop actually asked of `gh` — the
// stub logs each call — rather than trusting the loop's own description of
// itself. They spawn the real loop asynchronously at the 5s minimum interval,
// its sleep between ticks compressed through `AWAIT_ROUND_POLL_MS`, and change
// the fixtures under it.

describe.skipIf(process.platform === "win32")(
  "await-round.ts polling cost (TASK)",
  () => {
    const lines = (fix: Fixture, name: string): number => {
      try {
        return readFileSync(join(fix.dir, name), "utf8")
          .split("\n")
          .filter(Boolean).length;
      } catch {
        return 0;
      }
    };

    const checkRunReads = (fix: Fixture): number => {
      try {
        return readFileSync(join(fix.dir, "rest-calls.log"), "utf8")
          .split("\n")
          .filter((l) => l.includes("/check-runs")).length;
      } catch {
        return 0;
      }
    };

    async function until(
      what: string,
      cond: () => boolean,
      timeoutMs = 60_000,
    ): Promise<void> {
      const end = Date.now() + timeoutMs;
      while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    /** The real loop, running, with its own throwaway ETag cache. */
    function spawnLoop(
      fix: Fixture,
      args: string[],
      env: Record<string, string> = {},
    ): { done: Promise<{ code: number; stderr: string }>; kill: () => void } {
      const child = spawn(
        process.execPath,
        [join(SCRIPTS, "await-round.ts"), fix.pr, ...args],
        {
          cwd: repoDir,
          env: {
            ...gitCleanEnv(),
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            RRC_FIX: fix.dir,
            GH_CALL_TIMEOUT: "20",
            JIG_GH_CACHE_DIR: join(fix.dir, "etag-cache"),
            AWAIT_ROUND_POLL_MS: "100",
            ...env,
          },
        },
      );
      let stderr = "";
      child.stderr?.on("data", (d) => {
        stderr += String(d);
      });
      const done = new Promise<{ code: number; stderr: string }>((resolve) => {
        child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
      });
      return { done, kill: () => child.kill("SIGKILL") };
    }

    const PENDING = [check("AI review (shadow)", "pending", "IN_PROGRESS")];
    const SETTLED = [check("AI review (shadow)", "pass", "COMPLETED")];

    it("polls a numeric PR without a single `gh pr view` (state and head come over REST)", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(0);
      expect(lines(fix, "pr-view-calls.log")).toBe(0);
      expect(lines(fix, "rest-calls.log")).toBeGreaterThan(0);
    });

    it("refuses a PR that is not a number up front, before any gh call", () => {
      for (const bad of [
        "https://github.com/acme/widgets/pull/101",
        "feature/some-branch",
      ]) {
        const fix = writeFixture({ threads: [thread("PRRT_a")] });
        const r = runScript("await-round.ts", [bad, "--once"], fix);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("PR must be a number");
        expect(lines(fix, "pr-view-calls.log")).toBe(0);
        expect(lines(fix, "rest-calls.log")).toBe(0);
      }
    });

    it("does not re-ask `gh pr checks` while a pending verdict is confirmed unchanged, and re-reads the moment a check moves", async () => {
      const fix = writeFixture({ checks: PENDING });
      const loop = spawnLoop(fix, ["--interval", "5", "--timeout", "90"]);
      try {
        // Tick 1 reads (and primes the detector); ticks 2 and 3 are gated.
        await until("two gated polls", () => checkRunReads(fix) >= 3);
        expect(lines(fix, "pr-checks-calls.log")).toBe(1);
        expect(lines(fix, "rest-conditional.log")).toBeGreaterThanOrEqual(2);

        // Swapped in by rename, so no tick's stub can read a half-written file.
        const next = join(fix.dir, "checks.json.next");
        writeFileSync(next, JSON.stringify(SETTLED));
        renameSync(next, join(fix.dir, "checks.json"));
        const { code, stderr } = await loop.done;
        // The change was detected, `gh pr checks` was asked again, and its
        // verdict — not the stale cached one — decided the exit.
        expect(code).toBe(3);
        expect(stderr).toContain("converged");
        expect(lines(fix, "pr-checks-calls.log")).toBe(2);
      } finally {
        loop.kill();
      }
    }, 120_000);

    it("never trusts an unchanged signal for longer than AWAIT_ROUND_CHECKS_MAX_AGE", async () => {
      const fix = writeFixture({ checks: PENDING });
      const loop = spawnLoop(fix, ["--interval", "5", "--timeout", "90"], {
        AWAIT_ROUND_CHECKS_MAX_AGE: "1",
      });
      try {
        // Nothing ever changes, yet the age bound forces a fresh authoritative
        // read after the first reuse.
        await until(
          "a forced re-read",
          () => lines(fix, "pr-checks-calls.log") >= 2,
        );
        expect(lines(fix, "rest-conditional.log")).toBeGreaterThanOrEqual(1);
      } finally {
        loop.kill();
        await loop.done;
      }
    }, 120_000);

    // The fail-closed heart of the gate. The REST signals here are perfectly
    // steady (the stub's check-run body never changes), so a loop that cached an
    // ERROR verdict would see "unchanged" and stop re-asking — burning its retry
    // budget on a frozen answer instead of on fresh reads. Only a keep-waiting
    // verdict may ever be reused.
    it("re-asks `gh pr checks` on every tick while it keeps failing — an unreadable verdict is never reused", async () => {
      const fix = writeFixture({ checks: { exit: 1 } });
      const loop = spawnLoop(fix, ["--interval", "5", "--timeout", "90"]);
      try {
        const { code, stderr } = await loop.done;
        expect(code).toBe(1);
        expect(stderr).toContain("after 3 attempts");
        expect(lines(fix, "pr-checks-calls.log")).toBe(3);
      } finally {
        loop.kill();
      }
    }, 120_000);

    it("AWAIT_ROUND_CHECKS_MAX_AGE=0 disables the gate: every tick reads, and the detector is never queried", async () => {
      const fix = writeFixture({ checks: PENDING });
      const loop = spawnLoop(fix, ["--interval", "5", "--timeout", "90"], {
        AWAIT_ROUND_CHECKS_MAX_AGE: "0",
      });
      try {
        await until(
          "two full reads",
          () => lines(fix, "pr-checks-calls.log") >= 2,
        );
        expect(checkRunReads(fix)).toBe(0);
      } finally {
        loop.kill();
        await loop.done;
      }
    }, 120_000);

    it("rejects a malformed AWAIT_ROUND_CHECKS_MAX_AGE as a usage error", () => {
      const fix = writeFixture({});
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: { AWAIT_ROUND_CHECKS_MAX_AGE: "soon" },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("AWAIT_ROUND_CHECKS_MAX_AGE");
    });

    it("names the underlying reason when the PR state cannot be read", () => {
      const fix = writeFixture({ stateUnreadable: true });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`cannot read state of PR #${fix.pr}`);
      expect(r.stderr).toContain("gh api");
    });
  },
);

// These fixtures implement only sibling CLI responses, never lease state or a
// summary parser. Real producer/consumer tests live in the consumer repository.
function runWithSibling(
  script: string,
  args: string[],
  fix: Fixture,
  siblingScripts: Record<string, string>,
  opts: { stdin?: string; env?: Record<string, string> } = {},
) {
  const skills = mkdtempSync(join(tmpRoot, "optional-sibling-"));
  const scripts = join(skills, "resolve-review-comments", "scripts");
  cpSync(SCRIPTS, scripts, { recursive: true });
  if (Object.keys(siblingScripts).length) {
    const sibling = join(skills, "drive-pr", "scripts");
    mkdirSync(sibling, { recursive: true });
    for (const [name, source] of Object.entries(siblingScripts)) {
      writeFileSync(join(sibling, name), source);
    }
  }
  return runScript(script, args, fix, { ...opts, scriptsRoot: scripts });
}

const siblingRecorder = (exit: number) => `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SIBLING_LOG!, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(${exit});
`;

describe.skipIf(process.platform === "win32")(
  "optional sibling CLI boundaries",
  () => {
    const body = "**accepted** — added the guard; not yet pushed.\n";
    function mutations(fix: Fixture) {
      return readdirSync(fix.dir).filter((name) =>
        name.startsWith("graphql-input-"),
      );
    }
    for (const exit of [1, 11]) {
      it(`fence refusal ${exit} prevents the mutation and preserves the verdict`, () => {
        const fix = writeFixture({});
        const log = join(fix.dir, "fence.log");
        const r = runWithSibling(
          "reply-to-thread.ts",
          ["PRRT_fence"],
          fix,
          { "assert-post-allowed.ts": siblingRecorder(exit) },
          { stdin: body, env: { SIBLING_LOG: log } },
        );
        expect(r.code).toBe(exit);
        expect(mutations(fix)).toEqual([]);
        expect(JSON.parse(readFileSync(log, "utf8").trim())).toEqual([
          "--what",
          "reply-to-thread.ts (drive lease)",
        ]);
      });
    }
    it("a successful fence is called before posting the exact reply", () => {
      const fix = writeFixture({});
      const log = join(fix.dir, "fence.log");
      const r = runWithSibling(
        "reply-to-thread.ts",
        ["PRRT_fence"],
        fix,
        { "assert-post-allowed.ts": siblingRecorder(0) },
        { stdin: body, env: { SIBLING_LOG: log } },
      );
      expect(r.code).toBe(0);
      expect(JSON.parse(readFileSync(log, "utf8").trim())).toEqual([
        "--what",
        "reply-to-thread.ts (drive lease)",
      ]);
      expect(mutations(fix)).toHaveLength(1);
      const [mutation] = mutations(fix);
      if (!mutation) throw new Error("expected a recorded mutation");
      expect(readFileSync(join(fix.dir, mutation), "utf8")).toContain(
        body.trim(),
      );
    });
    for (const noOutcome of [false, true]) {
      // The liveness read is a network round trip; the lease fence must be the
      // LAST check before the reply so it cannot go stale during that read.
      it(`runs the harness fence after liveness, immediately before the reply (no-outcome=${noOutcome})`, () => {
        const fix = writeFixture({});
        const r = runWithSibling(
          "reply-to-thread.ts",
          ["PRRT_fence", ...(noOutcome ? ["--no-outcome"] : [])],
          fix,
          {
            "assert-post-allowed.ts": `
            import { appendFileSync } from "node:fs";
            appendFileSync(${JSON.stringify(join(fix.dir, "thread-events.log"))}, "fence\\n");
          `,
          },
          { stdin: body, env: { DRIVE_PR_TARGET: "99999" } },
        );
        expect(r.code).toBe(0);
        expect(mutations(fix)).toHaveLength(1);
        expect(readFileSync(join(fix.dir, "thread-events.log"), "utf8")).toBe(
          "liveness\nfence\nreply\n",
        );
      });
      it(`refuses when the lease is taken over during the liveness read (no-outcome=${noOutcome})`, () => {
        const fix = writeFixture({});
        // A fence that refuses once the liveness read has happened models a
        // replacement driver taking the lease while that read was pending.
        const r = runWithSibling(
          "reply-to-thread.ts",
          ["PRRT_fence", ...(noOutcome ? ["--no-outcome"] : [])],
          fix,
          {
            "assert-post-allowed.ts": `
            import { readFileSync } from "node:fs";
            const events = readFileSync(${JSON.stringify(join(fix.dir, "thread-events.log"))}, "utf8");
            process.exit(events.includes("liveness") ? 11 : 0);
          `,
          },
          { stdin: body, env: { DRIVE_PR_TARGET: "99999" } },
        );
        expect(r.code).toBe(11);
        expect(mutations(fix)).toEqual([]);
        expect(readFileSync(join(fix.dir, "thread-events.log"), "utf8")).toBe(
          "liveness\n",
        );
      });
    }
    // Documents the residual race the SKILL.md states: GitHub offers no
    // open-state precondition, so a merge landing after the liveness read —
    // here, during the fence — is NOT prevented. Do not read this as a guarantee.
    it("does not prevent a merge that lands during the fence (documented residual race)", () => {
      const fix = writeFixture({});
      const r = runWithSibling(
        "reply-to-thread.ts",
        ["PRRT_fence"],
        fix,
        {
          "assert-post-allowed.ts": `
            import { writeFileSync } from "node:fs";
            writeFileSync(${JSON.stringify(join(fix.dir, "state"))}, "MERGED");
          `,
        },
        { stdin: body, env: { DRIVE_PR_TARGET: "99999" } },
      );
      expect(r.code).toBe(0);
      // Proves the fence really ran and merged the PR, so this cannot degrade
      // into an ordinary OPEN-state posting test.
      expect(readFileSync(join(fix.dir, "state"), "utf8")).toBe("MERGED");
      expect(mutations(fix)).toHaveLength(1);
      expect(readFileSync(join(fix.dir, "thread-events.log"), "utf8")).toBe(
        "liveness\nreply\n",
      );
    });
    it("an installed sibling without its fence refuses before posting", () => {
      const fix = writeFixture({});
      const r = runWithSibling(
        "reply-to-thread.ts",
        ["PRRT_missing"],
        fix,
        { "unrelated.ts": "process.exit(0);" },
        { stdin: body },
      );
      expect(r.code).toBe(1);
      expect(mutations(fix)).toEqual([]);
    });
    it("an absent sibling permits standalone posting, but inherited drive context refuses", () => {
      for (const hasContext of [false, true]) {
        const fix = writeFixture({});
        const r = runWithSibling(
          "reply-to-thread.ts",
          ["PRRT_standalone"],
          fix,
          {},
          { stdin: body, env: hasContext ? { DRIVE_PR_TARGET: fix.pr } : {} },
        );
        expect(r.code).toBe(hasContext ? 1 : 0);
        expect(mutations(fix)).toHaveLength(hasContext ? 0 : 1);
      }
    });
    const summary =
      "console.log(JSON.stringify({ total: 0, unaddressed: [] }));";
    const release = siblingRecorder(0);
    for (const code of [0, 127]) {
      it(`releases a sessionless lease after an actual pass exits ${code}`, () => {
        const fix = writeFixture({ threads: [thread("PRRT_release")] });
        const log = join(fix.dir, "release.log");
        const pass = join(fix.dir, "pass.ts");
        writeFileSync(pass, `process.exit(${code});`);
        const r = runWithSibling(
          "converge.ts",
          [fix.pr, "--max-rounds", "1", "--", process.execPath, pass, fix.pr],
          fix,
          {
            "release-sessionless-lease.ts": release,
            "summary-findings.ts": summary,
          },
          { env: { SIBLING_LOG: log } },
        );
        expect(r.code).toBe(code === 0 ? 6 : 1);
        expect(JSON.parse(readFileSync(log, "utf8").trim())).toContain(fix.pr);
      });
    }
    for (const mode of [
      "converged",
      "dry-run",
      "zero-rounds",
      "failed-spawn",
    ]) {
      it(`does not release when no pass ran: ${mode}`, () => {
        const fix = writeFixture({
          threads: mode === "converged" ? [] : [thread("PRRT_hold")],
        });
        const log = join(fix.dir, "release.log");
        const args = [fix.pr];
        if (mode === "dry-run") args.push("--dry-run");
        else {
          if (mode === "zero-rounds") args.push("--max-rounds", "0");
          args.push("--", join(fix.dir, "missing-executable"), fix.pr);
        }
        const r = runWithSibling(
          "converge.ts",
          args,
          fix,
          {
            "release-sessionless-lease.ts": release,
            "summary-findings.ts": summary,
          },
          { env: { SIBLING_LOG: log } },
        );
        expect(r.code).toBe(
          mode === "converged" || mode === "dry-run"
            ? 0
            : mode === "zero-rounds"
              ? 6
              : 1,
        );
        expect(existsSync(log)).toBe(false);
      });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "fails CLOSED when the SKILLS PARENT disappears mid-run — the real path, not the predicate",
  async () => {
    // The predicate probes below cover the DECISION; this covers that
    // `assertPostAllowed` actually acts on it. Without this, deleting the
    // `if (!skillsParentIsIntact())` branch outright left every predicate
    // test green while restoring the exact fail-open they exist to guard —
    // a vacuous safety harness.
    //
    // The mid-run mutation is REAL here, not simulated: `main()` reads stdin
    // (line ~464) BEFORE it calls `assertPostAllowed` (~482), so a process
    // spawned with an open stdin pipe is parked with every module already
    // loaded and the fence not yet run. Deleting the skills root in that
    // window is precisely the state the guard is about — a tree changing
    // underneath an already-loaded process — reached without injecting a
    // probe or otherwise altering production code to be testable.
    const fix = writeFixture({});
    const skills = join(tmpRoot, "skills-parent-vanishes");
    const rrc = join(skills, "resolve-review-comments", "scripts");
    mkdirSync(join(skills, "resolve-review-comments"), { recursive: true });
    cpSync(SCRIPTS, rrc, { recursive: true });

    // Readiness is HANDSHAKED, not timed. A fixed `setTimeout` was the first
    // cut and is unsound on a loaded worker: module loading has no upper
    // bound, so an early timer deletes the tree mid-import and the run fails
    // on a module-load error instead of exercising the guard. Acknowledging
    // that in a comment, as the first cut did, is not preventing it.
    //
    // The marker is patched into the COPY, never into production: the copied
    // entrypoint writes it immediately before `readStdinAll()`, which is after
    // every static import has been evaluated and before the fence runs. That
    // is exactly the window this test needs, and it leaves `assertPostAllowed`
    // — the thing under test — untouched.
    const readyFile = join(tmpRoot, "skills-parent-vanishes-ready");
    const entry = join(rrc, "reply-to-thread.ts");
    const READY_ANCHOR = "const body = await readStdinAll();";
    const patched = readFileSync(entry, "utf8").replace(
      READY_ANCHOR,
      `{ const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready'); }\n  ${READY_ANCHOR}`,
    );
    // Assert the patch LANDED. A silently missed anchor (the string moves,
    // someone reformats the line) would restore the wall-clock race with no
    // signal — the "verify the mutation landed on the intended line" trap.
    expect(patched).toContain(readyFile);
    writeFileSync(entry, patched);

    const child = spawn(
      process.execPath,
      [join(rrc, "reply-to-thread.ts"), "PRRT_x"],
      {
        cwd: repoDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          RRC_FIX: fix.dir,
          GH_CALL_TIMEOUT: "20",
        },
      },
    );
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const exited = new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? -1));
    });

    // Wait for the child's own signal that imports are done and it is about to
    // read stdin. The deadline is a FAILURE bound, not a timing assumption:
    // arriving late is fine, never arriving is a real defect.
    const deadline = Date.now() + 20_000;
    while (!existsSync(readyFile)) {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error(
          `child never signalled readiness (stderr: ${stderr.slice(0, 400)})`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    rmSync(skills, { recursive: true, force: true });
    child.stdin?.end("**accepted** — fixed in abc1234.\n");

    const code = await exited;
    expect({
      code,
      posted: readdirSync(fix.dir).filter((name) =>
        name.startsWith("graphql-input-"),
      ).length,
    }).toEqual({
      code: 1,
      posted: 0,
    });
    // The guard's OWN message, not merely a non-zero exit: a module-load
    // failure from a mistimed delete also exits non-zero, and must not read as
    // this guard firing.
    expect(stderr).toContain("neither does the");
  },
  30_000,
);

describe("skillsParentIsIntact — the other half of an ENOENT (TASK)", () => {
  // An ENOENT on `<skills>/drive-pr` says the path does not resolve; it does
  // NOT say which component failed. The root alone being absent is the
  // standalone install; an ANCESTOR removed or renamed under an
  // already-loaded process is a damaged tree that says nothing about whether
  // a drive exists. The ENOTDIR fix the round before closed only the
  // prefix-is-a-FILE half — ENOENT still carried the prefix-is-GONE half
  // straight through the skip.
  //
  // These cover the DECISION table against real paths. They are deliberately
  // NOT the only coverage: on their own they stay green when the production
  // branch that consults them is deleted, which is a vacuous harness. The
  // end-to-end probe directly above
  // (`fails CLOSED when the SKILLS PARENT disappears mid-run`) is what pins the
  // branch itself, and it reddens under exactly that mutation.
  it("is true for a real directory — the ordinary install", () => {
    expect(skillsParentIsIntact(tmpRoot)).toBe(true);
  });

  it("is FALSE when the parent was removed — the damaged tree that used to skip", () => {
    expect(skillsParentIsIntact(join(tmpRoot, "never-created"))).toBe(false);
  });

  it("is FALSE when the parent is a FILE rather than a directory", () => {
    const notADir = join(tmpRoot, "skills-parent-is-a-file");
    writeFileSync(notADir, "not a directory\n");
    expect(skillsParentIsIntact(notADir)).toBe(false);
  });

  it("follows a symlink to a real directory — an ordinary layout, not damage", () => {
    // `stat`, not `lstat`: the question is whether the directory is there,
    // not how it is named. A repo whose skills/ is reached through a symlink
    // must keep posting, so this pins the choice of call rather than leaving
    // it to be re-litigated as "shouldn't this be lstat like the one above".
    const realDir = join(tmpRoot, "skills-symlink-target");
    const link = join(tmpRoot, "skills-via-symlink");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(
      realDir,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(skillsParentIsIntact(link)).toBe(true);
  });

  it("is FALSE for a DANGLING symlink — unreadable is not intact", () => {
    const link = join(tmpRoot, "skills-dangling-symlink");
    symlinkSync(
      join(tmpRoot, "symlink-target-does-not-exist"),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(skillsParentIsIntact(link)).toBe(false);
  });
});
