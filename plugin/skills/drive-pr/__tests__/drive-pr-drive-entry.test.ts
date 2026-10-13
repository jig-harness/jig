/**
 * drive-pr suite: drive.ts loop control — the pass environment and entry-mode
 * contract, progress stamps, the per-PR log, lock-refusal diagnostics, the
 * conflicting-PR and unavailable-base stops, and the intent-chain capture at arm.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import {
  DORMANT_ARM,
  scratchClean,
  gitCleanEnv,
  makeScratchRepo,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import {
  PASS_LOUD,
  PASS_NOOP,
  PASS_TASK,
  runDrive,
  runDriveIn,
  scratchLockName,
  state,
} from "./drive-loop-harness.ts";

useDrivePrSuite();

describe("drive.ts loop control", () => {
  it('hands the pass $DRIVE_PR_TARGET — the signal SKILL.md § Entry mode keys "driver pass, do not arm" on', async () => {
    // `/drive-pr` from a session ARMS a driver; from a drive.ts-spawned pass it
    // works one round. The only thing telling them apart is this variable, so a
    // driver that stopped exporting it would have every pass arm another driver
    // (unbounded recursion). Echoed unconditionally so the test could equally
    // read an empty value.
    const r = await runDrive(
      {
        threads: [
          {
            id: "PRRT_target_probe",
            path: "a.ts",
            bot: true,
            comments: [{ author: "example-review[bot]", bot: true, body: "x" }],
          },
        ],
      },
      [
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        "sh",
        "-c",
        'echo "pass for 999: TARGET=[$DRIVE_PR_TARGET]" >&2; exit 0',
      ],
    );
    expect(r.stderr).toContain("TARGET=[999]");
  });

  it("SKILL.md decides the entry mode before § 0 and the gate, on $DRIVE_PR_TARGET and --interactive", () => {
    // Prose contract pinned mechanically (references/consistency.md): the mode
    // decision must precede anything that takes the session lease, and must
    // key on the variable the test above proves the driver exports.
    const skill = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");
    const entry = skill.indexOf("## Entry mode");
    const oneRound = skill.indexOf("## One round");
    expect(entry).toBeGreaterThan(-1);
    expect(entry).toBeLessThan(oneRound);
    const section = skill.slice(entry, oneRound);
    expect(section).toContain("$DRIVE_PR_TARGET");
    expect(section).toContain("--interactive");
    // Each table row must bind its signal to its behaviour — mentioning the
    // variable and flag somewhere in the section is not enough.
    const row = (signal: string) =>
      section.split("\n").find((l) => l.startsWith(`| ${signal}`)) ?? "";
    // The row must send a pass to § Driver pass (which carries the
    // never-background prohibition) — the old "Skip the rest of this section"
    // wording skipped exactly that.
    expect(row("`$DRIVE_PR_TARGET` set")).toMatch(
      /Driver pass.*Read § Driver pass below first.*never-background.*work one round/,
    );
    expect(row("`$DRIVE_PR_TARGET` set")).not.toMatch(/Skip the rest/);
    expect(row("`$DRIVE_PR_TARGET` unset, no `--interactive`")).toMatch(
      /\*\*Arm\*\*.*Do \*\*not\*\* work a round yourself/,
    );
    expect(row("`$DRIVE_PR_TARGET` unset, `--interactive`")).toMatch(
      /One in-session round.*Work exactly one round/,
    );
    // A driver pass must not be told to background the step that pushes
    //: § 6 used to say "background that commit from the start", and
    // a pass that obeyed it exited with finish-round.ts dead and the commit
    // unpushed. Pin the prohibition, the foreground wait it points to, and
    // that § 6 no longer prescribes the backgrounding.
    const driverPass = skill.slice(skill.indexOf("### Driver pass"), oneRound);
    expect(driverPass).toMatch(/Never use the Bash tool's `run_in_background`/);
    expect(driverPass).toContain("foreground wait");
    // Launch-once / repeated-wait contract, and that the launch stays in the
    // pass's process group (no setsid/perl escape from drive.ts's witness).
    expect(driverPass).toMatch(/foreground-wait\.ts launch --/);
    expect(driverPass).toMatch(/foreground-wait\.ts wait/);
    expect(driverPass).toMatch(/Never call `launch` to resume a wait/);
    expect(driverPass).toMatch(/exit `21`/);
    expect(driverPass).toContain("--bots-only");
    expect(driverPass).not.toMatch(/setsid\(|perl -MPOSIX/);
    const step6 = skill.slice(
      skill.indexOf("### 6. Commit, then finish the round"),
      skill.indexOf("That is the whole of step 6."),
    );
    expect(step6).toContain("never background either one");
    expect(step6).not.toContain("background that commit from the start");
    // The decision table must precede the FIRST gate invocation anywhere in
    // the skill — the gate's --bump-attempt takes the session lease — and no
    // gate command may sit between the section heading and that table.
    const gateCmd = "drive-status.ts [PR] --json --once --bump-attempt";
    const table = skill.indexOf("| Signal | Mode |");
    const gate = skill.indexOf(gateCmd);
    expect(table).toBeGreaterThan(entry);
    expect(gate).toBeGreaterThan(-1);
    expect(table).toBeLessThan(gate);
    expect(skill.slice(entry, table)).not.toContain("drive-status.ts");
    // The arm command keeps the portable one-line `bun` form and --bots-only.
    expect(section).toContain(
      'bun ${CLAUDE_SKILL_DIR}/scripts/drive.ts <PR> --bots-only -- claude -p "/jig:drive-pr --bots-only <PR>"',
    );
  });

  it("stops on a merged PR WITHOUT running the pass", async () => {
    // The pass would push onto an orphaned branch. The marker in the pass's
    // own stderr is what proves it never ran.
    const r = await runDrive({ prState: "MERGED", threads: [] }, [
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.exitCode).toBe(5);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("warns about a 100%-unreadable bot reviewer before the round pass starts", async () => {
    const r = await runDrive(
      {
        threads: [
          {
            id: "PRRT_unreadable_severity",
            path: "a.ts",
            bot: true,
            comments: [
              {
                author: "format-switcher[bot]",
                bot: true,
                body: "formatter output no longer has a recognized severity",
              },
            ],
          },
        ],
      },
      ["--no-head-sync", "--max-rounds", "1", "--", ...PASS_LOUD],
    );
    expect(r.stderr).toContain("⚠ EVERY finding this round");
    expect(r.stderr).toContain("format-switcher[bot]");
    expect(r.stderr.indexOf("⚠ EVERY finding this round")).toBeLessThan(
      r.stderr.indexOf("RAN_THE_PASS"),
    );
  });

  it("stamps progress once round 1s pass has actually spawned — the signal that keeps a legitimately long round off the WEDGED threshold", async () => {
    // `PASS_NOOP` calls no `drive-state.ts` verb of its own (unlike
    // `bump-round`, which the PASS is responsible for per SKILL.md, not
    // drive.ts's own loop — see `grep -n bump-round drive.ts`, which has no
    // hits) — so `lastProgressAt` ending up set here can only be the
    // `progress --phase pass-spawned` stamp `drive.ts` itself issues from
    // `onSpawn`, once `run(agent, …)` has actually produced a child process.
    // A mutation deleting that call would leave `lastProgressAt` at
    // `freshState`'s own `''` forever, with nothing else in this minimal
    // fixture able to cover for it.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    const before = Date.now();
    await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--max-rounds",
      "1",
      "--",
      ...PASS_NOOP,
    ]);
    const s = JSON.parse((await state(stateDir, ["get", "999"])).stdout) as {
      lastProgressAt: string;
      phase: string;
    };
    expect(s.lastProgressAt).not.toBe("");
    expect(Date.parse(s.lastProgressAt)).toBeGreaterThanOrEqual(before);
    expect(s.phase).toBe("pass-spawned");
  });

  it("does NOT stamp pass-spawned progress when the pass executable never spawns at all", async () => {
    // A missing/invalid pass command usually does NOT fail inside `run()`'s
    // synchronous `spawn()` try/catch — Node reports the common ENOENT case
    // asynchronously via the child's 'error' event, and never assigns a
    // `pid` for it either (confirmed empirically), with the synchronous
    // `spawn()` call itself returning normally. `onSpawn` fires in the SAME
    // TICK `run()` is called in (never deferred to Node's async 'spawn'
    // event), gated on `child.pid !== undefined` checked immediately after
    // `spawn()` returns (`lib/proc.ts`: firing
    // unconditionally the moment `spawn()` returned without throwing, which
    // is not the same fact as the child actually having started), so it
    // still never fires here — but a claim that this depends on a
    // synchronous throw would be wrong for the case this test actually
    // exercises. Asserting the negative closes the gap: the
    // sibling test above only exercises the ordinary, successful-spawn path.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--max-rounds",
      "1",
      "--",
      // Contains the `999` token: `explicitPr` is `999` here (a PR was
      // named), so drive.ts's own mis-targeting guard requires it to appear
      // in the pass argv — a path with no digits at all fails that guard and
      // refuses at exit 2 BEFORE the round loop or `run(agent, …)` are ever
      // reached, which made `lastProgressAt === ''` true for the wrong
      // reason (never attempted, not "attempted and correctly not stamped")
      // and left this test unable to catch a stamp fired unconditionally
      // ahead of the spawn — the exact regression it exists to close.
      "/nonexistent/drive-pr-test-pass-999-xyz",
    ]);
    // Proves the mis-targeting guard did NOT short-circuit this run.
    expect(r.exitCode).not.toBe(2);
    expect(r.stderr).toContain("--- round 1/1 on PR #999 ---");
    // NOT asserting `lastProgressAt === ''` — round-advancement stamps it
    // (phase 'round-advanced') as soon as this head is first counted, well
    // before the pass is ever spawned, regardless of whether the spawn goes
    // on to succeed. That is what let the ORIGINAL fixture (no `999` token)
    // pass for the wrong reason too, just earlier: its mis-targeting refusal
    // pre-empts the counting gate entirely, so `lastProgressAt` stayed ''
    // for a reason that had nothing to do with `onSpawn`. The assertion this
    // test actually needs is on `phase`: only `onSpawn` firing would move it
    // to 'pass-spawned', so asserting it is still whatever round-advancement
    // left it at proves `onSpawn` never fired for this failed spawn.
    const s = JSON.parse((await state(stateDir, ["get", "999"])).stdout) as {
      phase: string;
    };
    expect(s.phase).not.toBe("pass-spawned");
  });

  it("appends the driver narrative to the durable per-PR log", async () => {
    // A drive is routinely a background child of a session that ends before
    // the drive does, so a console-only narrative dies with the session. The
    // MERGED stop is the cheapest full path through main(): tee installed,
    // path announced, drive stopped.
    const { dir, stateDir } = writeFixture({ prState: "MERGED", threads: [] });
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_NOOP,
    ]);
    expect(r.exitCode).toBe(5);
    const logPath = join(stateDir, "drive-pr-999.log");
    const log = readFileSync(logPath, "utf8");
    // The header names the writer; the announcement proves the tee was
    // installed BEFORE the first console line. The console stays
    // authoritative: the same announcement must still reach stderr.
    expect(log).toContain("driver narrative");
    expect(log).toContain(`drive.ts: driver log → ${logPath}`);
    expect(r.stderr).toContain(`drive.ts: driver log → ${logPath}`);
  });

  it("enriches the exit-11 refusal with the holder claim’s diagnostics", async () => {
    const { dir, stateDir } = writeFixture({ threads: [] });
    // The claim is planted as LITERAL bytes, not through formatClaim: the
    // refusal must read the wire format a real driver writes, and a
    // round-trip through the serializer would keep passing if both sides
    // drifted together.
    const lockDir = join(stateDir, await scratchLockName());
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "claim.feedfacefeedface"),
      `${process.pid} ${hostname()}\n${JSON.stringify({
        pr: "123",
        worktree: "/elsewhere/tree",
        log: "/elsewhere/drive-pr-123.log",
        started: "2026-08-15T00:00:00.000Z",
        account: {
          account: "dev@example.com",
          vendor: "claude",
          provenance: "oauthAccount",
          reason: null,
        },
      })}\n`,
    );
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.exitCode).toBe(11);
    expect(r.stderr).toContain(
      "another driver already holds the worktree lock",
    );
    expect(r.stderr).toContain("working PR #123 from /elsewhere/tree");
    expect(r.stderr).toContain("/elsewhere/drive-pr-123.log");
    // The holder's billing account rides along with the rest of
    // the diagnostics on the same refusal.
    expect(r.stderr).toContain(
      "Account: dev@example.com (claude, from oauthAccount)",
    );
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("a older claim (pid/host only) still refuses, degraded to its owner", async () => {
    const { dir, stateDir } = writeFixture({ threads: [] });
    const lockDir = join(stateDir, await scratchLockName());
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "claim.cafecafecafecafe"),
      `${process.pid} ${hostname()}\n`,
    );
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_NOOP,
    ]);
    expect(r.exitCode).toBe(11);
    expect(r.stderr).toContain(
      "another driver already holds the worktree lock",
    );
    expect(r.stderr).not.toContain("working PR #");
  });

  it("a older claim (diagnostics with no account key) still shows PR/worktree/log — only the account degrades, not the whole diagnostics line", async () => {
    // Same shape an earlier change always wrote, before an earlier change added `account` to
    // it. Unlike a claim with no diagnostics at all (the pid/host-only case
    // above), this is NOT flattened to "nothing to show": `lib/claim.ts`'s
    // `parseDiag` degrades only the missing `account` key, precisely
    // because an already-running, pre-upgrade driver's claim must stay
    // readable for `drives.ts --stop` and for its own pass's `ownParentDriver`
    // self-check (nulling the WHOLE diag here would make `--stop` refuse a
    // live in-flight driver and reproduce the stand-down bug for its own
    // pass).
    const { dir, stateDir } = writeFixture({ threads: [] });
    const lockDir = join(stateDir, await scratchLockName());
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "claim.deadbeefdeadbeef"),
      `${process.pid} ${hostname()}\n${JSON.stringify({
        pr: "123",
        worktree: "/elsewhere/tree",
        log: "/elsewhere/drive-pr-123.log",
        started: "2026-08-15T00:00:00.000Z",
      })}\n`,
    );
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_NOOP,
    ]);
    expect(r.exitCode).toBe(11);
    expect(r.stderr).toContain(
      "another driver already holds the worktree lock",
    );
    expect(r.stderr).toContain("working PR #123 from /elsewhere/tree");
    expect(r.stderr).toContain("/elsewhere/drive-pr-123.log");
    expect(r.stderr).toContain(
      "Account: unknown (claim written before the billing account was stamped)",
    );
  });

  it("runs a conflict-resolution pass before treating a CONFLICTING PR as terminal", async () => {
    // The older reasoning for stopping here was that an empty work
    // enumeration leaves "nothing for a triage pass to do". True of triage,
    // false of the pass: merging the base in is exactly what a conflict WITH
    // findings already gets, inside its own round.
    const r = await runDrive(
      {
        threads: [],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "1" } },
    );
    expect(r.stderr).toContain("TASK=conflict-resolve");
    // The base ref, so the pass merges the PR's OWN base rather than guessing
    // develop — the same failure the sibling test below pins for the message.
    expect(r.stderr).toContain("DETAIL=develop");
    expect(r.stderr).toContain("Running conflict-resolution pass 1/1");
    // The pass changed nothing, so the drive re-gates onto the same conflict
    // with the budget gone and takes the original terminal state.
    expect(r.exitCode).toBe(9);
    expect(r.stderr).toContain("git merge origin/develop");
  });

  it("preserves PR_NOT_OPEN from a repair pass instead of reporting a generic repair failure", async () => {
    // `guarded-push.ts` exits 5 inside a repair pass exactly like it does
    // inside the ordinary-pass ROUND_READY push — `passExitDisposition`
    // exists to route that to PR_NOT_OPEN for the ordinary path, and
    // `runRepairPass` used to collapse every non-zero repair-pass exit
    // (including 5) into a plain boolean, so this call site reported a
    // generic "conflict-resolution pass failed" and printed a `git merge`
    // fix for a PR that had already merged or closed underneath it.
    const r = await runDrive(
      {
        threads: [],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--no-head-sync", "--", "sh", "-c", ": pass for 999; exit 5"],
      undefined,
      { env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "1" } },
    );
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain(
      "stopped being open during the conflict-resolution pass",
    );
    expect(r.stderr).not.toContain(
      "the conflict-resolution pass failed; stopping with the manual fix below",
    );
    expect(r.stderr).not.toContain("git merge origin/develop");
  });

  it("--dry-run against a CONFLICTING PR with nothing to work reports FAST, not after minutes of internal polling", async () => {
    // The sibling CI-repair branch prints a `(dry-run) would run a CI-repair
    // pass for: …` line instead of silently taking the plain stop, and this
    // path used to fall straight through to the ordinary "conflicts …
    // stopping" message with no sign the automated repair was ever in the
    // running. drive-status.ts's own gate can never CERTIFY code 9 under a
    // dry run — `--no-count` (part of every dry-run probe's `probeFlags`,
    // unconditionally) suppresses the replied-thread reconciliation sweep
    // `UNRECONCILED_STOPPERS` requires before certifying a code in that set,
    // so the probe degrades to INDETERMINATE (1) instead, REGARDLESS of
    // `--once` (asserting that degraded exit as the intended behaviour would
    // make the preview below dead code and contradict README.md's own
    // "`--dry-run` reports what each round would do"). The fix reads the SAME
    // condition `evaluate()` uses to decide PR_CONFLICTING — mergeable ===
    // 'CONFLICTING' and nothing LIVE left to work — directly off the
    // already-fetched, non-mutating report, rather than waiting on a sweep
    // dry-run deliberately never runs.
    //
    // What this ALSO still pins is the earlier real bug found while testing
    // this message: without `--once`, drive-status.ts took its own internal
    // polling path for a code it can never certify under suppression — up to
    // its full `--timeout` (1800s / 30 minutes by default) — before finally
    // giving up. `--once` (added alongside `--no-count` at this call site)
    // makes the honest "cannot certify" answer arrive immediately instead —
    // which is what the fast preview below builds on.
    const start = Date.now();
    const r = await runDrive(
      {
        threads: [],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--dry-run", "--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "1" } },
    );
    // Generous relative to the near-instant true cost (a couple of stubbed
    // `gh` calls), but far short of even one of drive-status.ts's own
    // internal `--interval` sleeps (30s default) — so this fails loudly if
    // `--once` is ever dropped from the dry-run probe flags rather than
    // silently costing the suite tens of seconds per run.
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(r.exitCode).toBe(9);
    expect(r.stderr).toContain(
      "(dry-run) would run a conflict-resolution pass against origin/develop",
    );
    expect(r.stderr).not.toContain("RAN_THE_PASS");
    expect(r.stderr).not.toContain("TASK=conflict-resolve");
  });

  it("does NOT print the conflict-resolve preview under --dry-run when the conflicting head still has live findings", async () => {
    // The new preview recognises PR_CONFLICTING's OWN condition —
    // mergeable === 'CONFLICTING' and nothing LIVE left to work — directly
    // off the report. A conflicting head with a real unresolved thread is
    // the OTHER, non-terminal case (`ROUND_READY`, since the live reviewer
    // is a poller with no mergeability term and reviews conflicting heads
    // too): the preview must not misfire there just because mergeable is
    // CONFLICTING, since there is genuine review work still to hand out.
    const r = await runDrive(
      {
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--dry-run", "--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "1" } },
    );
    expect(r.stderr).not.toContain(
      "(dry-run) would run a conflict-resolution pass",
    );
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("--dry-run does NOT preview a conflict-resolution pass when the repair budget is disabled", async () => {
    // The early --dry-run shortcut above recognises PR_CONFLICTING directly
    // off the status report, bypassing the real code-9 switch branch that
    // consults `conflictRepairRounds()` before deciding whether to preview a
    // repair pass or the manual stop. Before this fix the shortcut always
    // printed "would run a conflict-resolution pass", even with
    // DRIVE_PR_CONFLICT_REPAIR_ROUNDS=0 — where the real, non-dry-run path
    // takes the manual exit-9 stop instead, never dispatching a pass. Pin
    // that the preview now matches the real decision.
    const r = await runDrive(
      {
        threads: [],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--dry-run", "--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "0" } },
    );
    expect(r.exitCode).toBe(9);
    expect(r.stderr).not.toContain(
      "(dry-run) would run a conflict-resolution pass",
    );
    expect(r.stderr).toContain("conflicts with its base");
    expect(r.stderr).toContain("git merge origin/develop");
    expect(r.stderr).toContain("DRIVE_PR_CONFLICT_REPAIR_ROUNDS=0");
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("stops on a CONFLICTING PR WITHOUT running the pass, and names the fix", async () => {
    // THIS fixture has no findings, so handing the round over would spend it
    // reading an empty review — and the operator has to be told to merge, not
    // that a reviewer is slow. The emptiness is a property of the
    // fixture, NOT of conflicting heads: the live reviewer is a poller with no
    // mergeability term in its eligibility predicate, so it can and does
    // publish findings on a conflicting head. The sibling test below pins that
    // case as ROUND_READY.
    const r = await runDrive(
      {
        threads: [],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--no-head-sync", "--", ...PASS_LOUD],
      undefined,
      // `0` restores the pre-repair behaviour this test is about —
      // terminal on arrival, pass never spawned.
      { env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "0" } },
    );
    expect(r.exitCode).toBe(9);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
    expect(r.stderr).toContain("conflicts with its base");
    expect(r.stderr).toContain("git merge origin/develop");
  });

  it("reports the base as unavailable rather than guessing develop", async () => {
    // An implementation that defaults an unreadable base
    // name to `develop` (`${base:-develop}`) gives a concrete, WRONG command
    // for any release-branch or stacked PR. It also makes a second, ungated
    // `gh pr view` call to fetch it, which this fix removes entirely by reading
    // the base name out of the status JSON drive-status.ts already produced.
    //
    // an earlier change gave this test a second job, which is why it runs with the
    // conflict-repair budget at its DEFAULT rather than disabled: an
    // unreadable base name must not spend a repair round either. Dispatching
    // a pass with an empty base makes the same `develop` guess one level
    // further away, where the operator cannot see it being made — so
    // `RAN_THE_PASS` below now also pins that the repair was declined.
    const r = await runDrive(
      {
        threads: [],
        checkRuns: [DORMANT_ARM],
        mergeable: "CONFLICTING",
        baseRefNameMissing: true,
      },
      ["--no-head-sync", "--", ...PASS_LOUD],
    );
    expect(r.exitCode).toBe(9);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
    expect(r.stderr).not.toContain("git merge origin/develop");
    expect(r.stderr).toContain("base branch name unavailable");
  });

  // Drive.ts keeps an existing PR pin at arm, through
  // capture-intent-chain.ts. The capture is best-effort by contract — a refusal
  // (exit 3) or a failure must never stop or change the outcome of the drive —
  // and --dry-run must not write a pin at all.
  it("runs the intent-chain capture at arm, and a refused capture (exit 3) does not change the drive outcome", async () => {
    // The scratch repo is not on the fixture PR's head branch
    // (`feature/an earlier change-probe`), so the capture's own verification refuses.
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
      isDraft: false,
    });
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.stderr).toContain("intent chain: not pinned for PR #999");
    expect(r.stderr).toContain("not PR #999's head branch");
    expect(r.exitCode).toBe(0);
  });

  it("refuses a new pin without a pickup token even on the PR head branch", async () => {
    // A matching branch and mutable item file cannot identify the original
    // pickup. The driver's tokenless re-arm must refuse instead of guessing.
    const repo = makeScratchRepo("scratch-capture");
    const co = Bun.spawnSync(
      ["git", "checkout", "-q", "-b", "feature/ENG-9999-probe"],
      { cwd: repo.dir, env: gitCleanEnv() },
    );
    expect(co.exitCode).toBe(0);
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: repo.head,
      head: repo.head,
      isDraft: false,
    });
    const contextDir = join(dir, "context");
    const chains = join(contextDir, "intent-chain");
    mkdirSync(chains, { recursive: true });
    const snapshot =
      "<!-- refocus-arm: on -->\n<intent_chain>ENG-9999 probe chain</intent_chain>\n";
    writeFileSync(join(chains, "ENG-9999.md"), snapshot);
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--", ...PASS_LOUD],
      repo.dir,
      {
        env: {
          DRIVE_PR_INTENT_CHAIN_DIR: contextDir,
        },
      },
    );
    expect(r.stderr).toContain("intent chain: not pinned for PR #999");
    expect(r.stderr).toContain("a new pin requires --pickup");
    expect(existsSync(join(chains, "pr.999.md"))).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it("keeps the driven checkout pin when the driver inherits GIT_DIR/GIT_WORK_TREE for another one", async () => {
    // `runDriveIn` starts from `gitCleanEnv()`, so the success test above
    // cannot see a missing scrub. Here the driver INHERITS a location naming
    // a decoy checkout on a non-PR branch: if any git call deriving the
    // capture spawn's tree honoured it, the branch check would read the decoy
    // and refuse to pin.
    const repo = makeScratchRepo("scratch-capture-real");
    const decoy = makeScratchRepo("scratch-capture-decoy");
    const co = Bun.spawnSync(
      ["git", "checkout", "-q", "-b", "feature/ENG-9999-probe"],
      { cwd: repo.dir, env: gitCleanEnv() },
    );
    expect(co.exitCode).toBe(0);
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: repo.head,
      head: repo.head,
      isDraft: false,
    });
    const contextDir = join(dir, "context");
    const chains = join(contextDir, "intent-chain");
    mkdirSync(chains, { recursive: true });
    writeFileSync(
      join(chains, "pr.999.md"),
      "<!-- refocus-arm: on -->\n<intent_chain>ENG-9999 probe chain</intent_chain>\n",
    );
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--", ...PASS_LOUD],
      repo.dir,
      {
        env: {
          DRIVE_PR_INTENT_CHAIN_DIR: contextDir,
          GIT_DIR: join(decoy.dir, ".git"),
          GIT_WORK_TREE: decoy.dir,
        },
      },
    );
    expect(r.stderr).toContain("intent chain: pinned for PR #999");
    expect(r.stderr).toContain("kept");
    expect(readFileSync(join(chains, "pr.999.md"), "utf8")).toContain(
      "ENG-9999 probe chain",
    );
  });

  it("does not run the intent-chain capture under --dry-run", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
      isDraft: false,
    });
    const r = await runDriveIn(dir, stateDir, [
      "--dry-run",
      "--no-head-sync",
      "--",
      ...PASS_LOUD,
    ]);
    expect(r.stderr).not.toContain("intent chain:");
  });
});
