/**
 * scripts-rounds.test.ts — `await-round.ts`'s review round counting: one
 * round per distinct head, counted into `/drive-pr`'s review round record
 * whether or not a drive runs, the structural-escalation nudge past the
 * threshold, and, at convergence, the reflection prompt and the settling of
 * the loop's rounds. The stub `gh` and the fixture helpers are in
 * scripts-harness.ts; each counting probe gets the suite's throwaway drive
 * database there.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  binDir,
  countRounds,
  gitCleanEnv,
  HEAD_B,
  repoDir,
  rounds,
  runScript,
  SCRIPTS,
  thread,
  useStubForge,
  writeFixture,
} from "./scripts-harness.ts";

useStubForge();

describe("await-round.ts review rounds", () => {
  it("counts a round per distinct head, not per invocation", () => {
    const fix = writeFixture({ threads: [thread("PRRT_a")] });
    runScript("await-round.ts", [fix.pr, "--once"], fix);
    expect(rounds(fix.pr)).toEqual({ round: 1, open: 1 });
    // A retry on the same head is a driver retry, not a reviewer round.
    runScript("await-round.ts", [fix.pr, "--once"], fix);
    expect(rounds(fix.pr)).toEqual({ round: 1, open: 1 });
    // A new push IS a new round.
    writeFileSync(join(fix.dir, "head"), `${HEAD_B}\n`);
    runScript("await-round.ts", [fix.pr, "--once"], fix);
    expect(rounds(fix.pr)).toEqual({ round: 2, open: 2 });
  });

  // A loop run by hand, with no drive anywhere: no DRIVE_PR_* variable at
  // all, so the count goes to the drive database's default place, under
  // HOME, as it does on a machine that never armed a drive.
  it("keeps counting across heads in a hand-driven loop with no driver", () => {
    const fix = writeFixture({ threads: [thread("PRRT_a")] });
    const home = mkdtempSync(join(tmpdir(), "rrc-no-drive-home-"));
    try {
      const env = {
        ...gitCleanEnv(),
        HOME: home,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RRC_FIX: fix.dir,
        GH_CALL_TIMEOUT: "20",
      };
      const loop = () =>
        spawnSync(
          process.execPath,
          [join(SCRIPTS, "await-round.ts"), fix.pr, "--once"],
          { encoding: "utf8", cwd: repoDir, env },
        );
      const roundNow = () =>
        spawnSync(
          process.execPath,
          [join(SCRIPTS, "current-round.ts"), fix.pr],
          { encoding: "utf8", cwd: repoDir, env },
        ).stdout.trim();
      expect(Object.keys(env).some((k) => k.startsWith("DRIVE_PR_"))).toBe(
        false,
      );
      expect(loop().status).toBe(0);
      expect(roundNow()).toBe("1");
      writeFileSync(join(fix.dir, "head"), `${HEAD_B}\n`);
      expect(loop().status).toBe(0);
      expect(roundNow()).toBe("2");
      // Both rounds are open in the drive database under HOME.
      const open = spawnSync(
        process.execPath,
        [
          join(SCRIPTS, "..", "..", "drive-pr", "scripts", "drive-state.ts"),
          "open-rounds",
          fix.pr,
        ],
        { encoding: "utf8", cwd: repoDir, env },
      );
      expect(open.stdout.trim()).toBe("2");
      expect(
        existsSync(
          join(home, ".local", "state", "jig", "drive-pr", "state.sqlite"),
        ),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
    expect(rounds(fix.pr).round).toBe(1);
    rmSync(join(fix.dir, "head"), { force: true });
    runScript("await-round.ts", [fix.pr, "--once"], fix);
    runScript("await-round.ts", [fix.pr, "--once"], fix);
    expect(rounds(fix.pr).round).toBe(1);
  });

  it("--no-count inspects without counting", () => {
    const fix = writeFixture({ threads: [thread("PRRT_a")] });
    runScript("await-round.ts", [fix.pr, "--once", "--no-count"], fix);
    expect(rounds(fix.pr)).toEqual({ round: 0, open: 0 });
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

  it("with reflection on, notes the round count and asks for /jig:reflect at wind-down, and settles the rounds", () => {
    const fix = writeFixture({ threads: [] });
    countRounds(fix.pr, 5);
    const journal = join(fix.dir, "journal.jsonl");
    const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
      env: {
        JIG__REFLECTION__ENABLED: "true",
        JIG__REFLECTION__JOURNAL: journal,
      },
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("converged after 5 rounds");
    expect(r.stderr).toContain("/jig:reflect");
    // Settled for the next review's prompt; the PR's round stands.
    expect(rounds(fix.pr)).toEqual({ round: 5, open: 0 });
    const noted = JSON.parse(readFileSync(journal, "utf8").trim());
    expect(noted).toMatchObject({
      type: "finding",
      class: "review-took-many-rounds",
      change: { pull_request: Number(fix.pr) },
      title: `Pull request #${fix.pr} took 5 review rounds to converge`,
    });
    expect(noted.session.skills).toEqual(["resolve-review-comments"]);

    // Another long review of the same pull request is a new measurement.
    countRounds(fix.pr, 7, "d");
    const again = runScript("await-round.ts", [fix.pr, "--once"], fix, {
      env: {
        JIG__REFLECTION__ENABLED: "true",
        JIG__REFLECTION__JOURNAL: journal,
      },
    });
    expect(again.code).toBe(3);
    const titles = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).title);
    expect(titles).toEqual([
      `Pull request #${fix.pr} took 5 review rounds to converge`,
      `Pull request #${fix.pr} took 7 review rounds to converge`,
    ]);
  });

  it("keeps the round count when the journal cannot take it, and says so", () => {
    const fix = writeFixture({ threads: [] });
    countRounds(fix.pr, 5);
    // A directory where the journal file should be: the write fails.
    const journal = join(fix.dir, "journal-dir");
    mkdirSync(journal);
    const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
      env: {
        JIG__REFLECTION__ENABLED: "true",
        JIG__REFLECTION__JOURNAL: journal,
      },
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain(
      "could not be written to the reflection journal",
    );
    expect(r.stderr).not.toContain("is in the reflection journal");
    expect(rounds(fix.pr).open).toBe(5);
  });

  it("with reflection off, settles the rounds without asking for a reflection", () => {
    const fix = writeFixture({ threads: [] });
    countRounds(fix.pr, 5);
    const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
    expect(r.code).toBe(3);
    expect(r.stderr).not.toContain("converged after 5 rounds");
    expect(r.stderr).not.toContain("reflect");
    expect(rounds(fix.pr)).toEqual({ round: 5, open: 0 });
  });

  it("a converged --no-count probe neither settles the rounds nor fires the prompt", () => {
    const fix = writeFixture({ threads: [] });
    countRounds(fix.pr, 5);
    const r = runScript(
      "await-round.ts",
      [fix.pr, "--once", "--no-count"],
      fix,
      { env: { JIG__REFLECTION__ENABLED: "true" } },
    );
    expect(r.code).toBe(3);
    expect(r.stderr).not.toContain("reflect");
    expect(rounds(fix.pr).open).toBe(5);
  });
});
