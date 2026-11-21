/**
 * drive-pr suite: drive.ts on a red final CI verdict — the /fix-ci stop, the
 * CI-repair round and its budget, the unlabel-triggered witness, and the
 * failing-check names a verdict carries.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { CI_REPAIR_SPENT_EXIT } from "../scripts/lib/driver/settings.ts";
import type {
  CheckRun as EvidenceCheckRun,
  CommitStatus as EvidenceCommitStatus,
} from "../scripts/lib/status/evidence";
import {
  failingNames,
  failingStatusNames,
} from "../scripts/lib/status/evidence";

import { parkRecord } from "./park-record-fixture.ts";
import {
  type CheckRunFixture,
  REVIEWER_RUN,
  DORMANT_ARM,
  gitCleanEnv,
  makeScratchRepo,
  scratchClean,
  writeFixture as rawFixture,
  probeIn,
  SCRIPTS,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import {
  FAILING_RUN,
  PASS_LOUD,
  PASS_TASK,
  runDrive,
  runDriveIn,
  state,
  skipLongDriveFixture,
} from "./drive-loop-harness.ts";

const writeFixture = (f: Parameters<typeof rawFixture>[0]) =>
  rawFixture(f, scratchClean.dir);

useDrivePrSuite();

describe("drive.ts loop control", () => {
  // A red final verdict is a REPAIR round before it is a stop, so
  // every pre-existing "stops for /fix-ci" expectation below now pins the
  // budget-exhausted fallback explicitly (`DRIVE_PR_CI_REPAIR_ROUNDS=0`)
  // rather than relying on a default that no longer stops on the first red.
  // The repair path itself is covered by the block that follows them.
  const NO_REPAIR = { DRIVE_PR_CI_REPAIR_ROUNDS: "0" };

  it("stops for /fix-ci when the PR-open full-CI witness completed red", async () => {
    const r = await runDrive(
      {
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
      },
      ["--keep-draft", "--no-head-sync", "--", ...PASS_LOUD],
      undefined,
      { env: NO_REPAIR },
    );
    expect(r.stderr).toContain("stopping for /fix-ci");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("runs a CI-repair pass on a red final verdict instead of stopping", async () => {
    const r = await runDrive(
      {
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
      },
      [
        "--keep-draft",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        ...PASS_TASK,
      ],
      undefined,
      { env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" } },
    );
    // The pass ran, and it ran as a REPAIR: the task and the failing check
    // names both reached it. Without the detail a /fix-ci pass has no idea
    // which checks to chase.
    expect(r.stderr).toContain("TASK=ci-repair");
    expect(r.stderr).toContain("DETAIL=code-quality-and-build");
    expect(r.stderr).toContain("Running CI-repair pass 1/1");
  });

  it("rejects a diagnosing repair report with a malformed tracker issue", async () => {
    // The pass exits 0 but changes nothing, so the drive re-gates onto the
    // identical red verdict. Budget 1 grants one ordinary repair before diagnosis.
    const r = await runDrive(
      {
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
      },
      [
        "--keep-draft",
        "--no-head-sync",
        "--",
        "sh",
        "-c",
        ': pass for 999; if [ "$DRIVE_PR_ROUND_TASK" = ci-diagnose ]; then echo "diagnosing now" >&2; printf \'%s\\n\' \'{"diagnosis":"the local gate ran no tests","issue":"not a key"}\' > "$DRIVE_PR_CI_DIAGNOSIS_REPORT"; fi',
      ],
      undefined,
      { env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" } },
    );
    expect(r.stderr).toContain("Running CI-repair pass 1/1");
    expect(r.stderr).toContain("diagnosing now");
    expect(r.stderr).toContain(
      "a diagnosis and either a tracker issue key or the key of the filing it parked",
    );
    expectSpawnExit({ ...r, stdout: null }, CI_REPAIR_SPENT_EXIT);
  }, 20_000);

  // A pass that omits the issue key must name the filing decision it parked
  // during this diagnosis: the driver reads the drive state for that park.
  const FILING_KEY = "ci-diagnosis-filing";
  const diagnoseOnly = (body: string) => [
    "sh",
    "-c",
    `: pass for 999; if [ "$DRIVE_PR_ROUND_TASK" = ci-diagnose ]; then echo "diagnosing now" >&2; ${body}; fi`,
  ];
  const diagnoseOnRed = async (pass: string[]) =>
    await runDrive(
      {
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
      },
      ["--keep-draft", "--no-head-sync", "--", ...pass],
      undefined,
      {
        env: {
          DRIVE_PR_CI_REPAIR_ROUNDS: "1",
          JIG__dispatch__person: "maintainer",
        },
      },
    );

  it("keeps the diagnosis of a report that parked the issue filing", async () => {
    // The pass exits 0 but changes nothing, so the drive re-gates onto the
    // identical red verdict. Budget 1 grants one ordinary repair before diagnosis.
    const record = join(
      mkdtempSync(join(tmpdir(), "diagnosis-park-")),
      "record.json",
    );
    writeFileSync(
      record,
      parkRecord(
        "File the recurring CI cause as a tracker issue",
        "human-decision",
      ),
    );
    const r = await diagnoseOnRed(
      diagnoseOnly(
        `"${join(SCRIPTS, "drive-state.ts")}" park 999 --key ${FILING_KEY} --kind finding --class human-decision < "${record}" && printf '%s\\n' '{"diagnosis":"the local gate ran no tests","parked":"${FILING_KEY}"}' > "$DRIVE_PR_CI_DIAGNOSIS_REPORT"`,
      ),
    );
    expect(r.stderr).toContain("Running CI-repair pass 1/1");
    expect(r.stderr).toContain("diagnosing now");
    expect(r.stderr).toContain(
      "no issue filed (parked for a person). the local gate ran no tests",
    );
    expectSpawnExit({ ...r, stdout: null }, CI_REPAIR_SPENT_EXIT);
  }, 20_000);

  it("rejects a diagnosis report with no issue key and no parked filing", async () => {
    const r = await diagnoseOnRed(
      diagnoseOnly(
        `printf '%s\\n' '{"diagnosis":"done"}' > "$DRIVE_PR_CI_DIAGNOSIS_REPORT"`,
      ),
    );
    expect(r.stderr).toContain("diagnosing now");
    expect(r.stderr).toContain(
      "a diagnosis and either a tracker issue key or the key of the filing it parked",
    );
    expect(r.stderr).not.toContain("parked for a person");
    expectSpawnExit({ ...r, stdout: null }, CI_REPAIR_SPENT_EXIT);
  }, 20_000);

  it("rejects a diagnosis report naming a filing park the drive does not hold", async () => {
    const r = await diagnoseOnRed(
      diagnoseOnly(
        `printf '%s\\n' '{"diagnosis":"done","parked":"${FILING_KEY}"}' > "$DRIVE_PR_CI_DIAGNOSIS_REPORT"`,
      ),
    );
    expect(r.stderr).toContain("diagnosing now");
    expect(r.stderr).toContain(
      `names the filing park ${FILING_KEY}, but this diagnosis parked no human-decision under that key`,
    );
    expect(r.stderr).not.toContain("parked for a person");
    expectSpawnExit({ ...r, stdout: null }, CI_REPAIR_SPENT_EXIT);
  }, 20_000);

  it("re-gates without stopping when the diagnosing pass stands down", async () => {
    const r = await diagnoseOnRed(
      diagnoseOnly(
        `if [ ! -e "$DRIVE_PR_STATE_DIR/.stood-down" ]; then : > "$DRIVE_PR_STATE_DIR/.stood-down"; printf '%s\\n' '{"standDown":true}' > "$DRIVE_PR_CI_DIAGNOSIS_REPORT"; else printf '%s\\n' '{"diagnosis":"second try","issue":"#42"}' > "$DRIVE_PR_CI_DIAGNOSIS_REPORT"; fi`,
      ),
    );
    // The stand-down released the head's diagnosis: a second one ran.
    expect(r.stderr.match(/Running diagnosing CI repair/g)?.length).toBe(2);
    expect(r.stderr).not.toContain(
      "a diagnosis and either a tracker issue key",
    );
    expect(r.stderr).toContain("issue #42. second try");
    expectSpawnExit({ ...r, stdout: null }, CI_REPAIR_SPENT_EXIT);
  }, 20_000);

  const failingHead = (head: string) => ({
    threads: [],
    head,
    reviewedSha: head,
    checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
  });
  const diagnosisPass = (action: string) => [
    "sh",
    "-ec",
    `# pass for 999
    if [ "$DRIVE_PR_ROUND_TASK" != ci-diagnose ]; then exit 0; fi
    printf '%s\\n' '{"diagnosis":"The local gate skipped the CI comparison.","issue":"#42"}' > "$DRIVE_PR_CI_DIAGNOSIS_REPORT"
    ${action}`,
  ];
  const driveWithDiagnosis = ["--keep-draft", "--no-head-sync", "--"];
  const oneRepair = { DRIVE_PR_CI_REPAIR_ROUNDS: "1" };

  it("stops with the diagnosis and tracker key when the diagnosing repair cannot push a fix", async () => {
    const { dir, stateDir } = writeFixture(failingHead(scratchClean.head));
    const result = await runDriveIn(
      dir,
      stateDir,
      [...driveWithDiagnosis, ...diagnosisPass("exit 1")],
      undefined,
      { env: oneRepair },
    );
    expectSpawnExit({ ...result, stdout: null }, CI_REPAIR_SPENT_EXIT);
    expect(result.stderr).toContain(
      "issue #42. The local gate skipped the CI comparison.",
    );
    const stored = await state(stateDir, ["get", "999"]);
    expectSpawnExit(stored, 0);
    expect(JSON.parse(stored.stdout).ciActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: expect.stringContaining(
            `diagnosis: head ${scratchClean.head}: issue #42.`,
          ),
        }),
      ]),
    );
  }, 20_000);

  it("continues the drive on the head pushed by the diagnosing repair", async () => {
    const tree = makeScratchRepo("ci-diagnosis-push");
    const git = (...args: string[]) => {
      const spawn = Bun.spawnSync(["git", ...args], {
        cwd: tree.dir,
        env: gitCleanEnv(),
      });
      expectSpawnExit(spawn, 0);
      return spawn.stdout.toString().trim();
    };
    git("commit", "--allow-empty", "-qm", "CI repair");
    const pushedHead = git("rev-parse", "HEAD");
    git("reset", "--hard", tree.head);
    const red = rawFixture(failingHead(tree.head), tree.dir);
    const green = rawFixture({ head: pushedHead }, tree.dir);
    const result = await runDriveIn(
      red.dir,
      red.stateDir,
      [
        ...driveWithDiagnosis,
        ...diagnosisPass(`git merge --ff-only "$FIXED_HEAD"
          for name in pr-view check-runs issue-comments; do
            cp "$FIXED_EVIDENCE/$name.json" "$DRIVE_PR_FIXTURES/$name.json"
          done
          printf '{"diagnosis":"The local gate skipped the CI comparison.","issue":"#42","pushedHead":"%s"}\\n' "$FIXED_HEAD" > "$DRIVE_PR_CI_DIAGNOSIS_REPORT"`),
      ],
      tree.dir,
      {
        env: {
          ...oneRepair,
          FIXED_HEAD: pushedHead,
          FIXED_EVIDENCE: green.dir,
        },
      },
    );
    expectSpawnExit({ ...result, stdout: null }, 0);
    expect(result.stderr).toContain(`The pull request moved to ${pushedHead}`);
  }, 20_000);

  /** A converged red head, driven with `drive.ci_repair_rounds: 1` in the configuration. */
  async function driveWithRepairSetting(env: Record<string, string>) {
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
    });
    // The suite's own configuration, with the setting added to its section.
    const overlay = join(dir, "repair-rounds.yaml");
    const base = readFileSync(
      join(import.meta.dir, "fixtures", "overlay.yaml"),
      "utf8",
    );
    writeFileSync(
      overlay,
      base.replace(/^drive:\n/m, "drive:\n  ci_repair_rounds: 1\n"),
    );
    return runDriveIn(
      dir,
      stateDir,
      ["--keep-draft", "--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { JIG_OVERLAY: overlay, ...env } },
    );
  }

  it("spends the repository's drive.ci_repair_rounds", async () => {
    const r = await driveWithRepairSetting({});
    expect(r.stderr).toContain("Running CI-repair pass 1/1");
    expect(r.stderr).toContain("TASK=ci-diagnose");
    expectSpawnExit({ ...r, stdout: null }, CI_REPAIR_SPENT_EXIT);
  }, 20_000);

  it("lets DRIVE_PR_CI_REPAIR_ROUNDS override drive.ci_repair_rounds for one run", async () => {
    const r = await driveWithRepairSetting(NO_REPAIR);
    expect(r.stderr).toContain("stopping for /fix-ci");
    expect(r.stderr).not.toContain("Running CI-repair pass");
    expectSpawnExit({ ...r, stdout: null }, 1);
  });

  it("--dry-run against a converged PR with a red final verdict previews the CI-repair pass", async () => {
    // Unlike case 9 (PR_CONFLICTING), this preview lives inside CONVERGED
    // (code 3) handling. `UNRECONCILED_STOPPERS` (drive-status.ts) only
    // withholds certification for codes {2,7,8,9,10} under `--no-count` —
    // code 3 is explicitly exempted (see its own `convergedUnswept` guard,
    // a narrower and different condition) — so a `--dry-run` probe's
    // `--no-count --once` flags never stood between this branch and a real
    // CONVERGED verdict the way they did for case 9's. This pins the preview
    // the way its sibling (the CONFLICTING dry-run test above) is pinned;
    // there is no reachability bug here, only coverage.
    const r = await runDrive(
      {
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
      },
      [
        "--dry-run",
        "--keep-draft",
        "--no-head-sync",
        "--",
        "sh",
        "-c",
        // `PASS_TASK` alone never echoes an unconditional marker, so
        // `not.toContain('RAN_THE_PASS')` against it can't fail either way —
        // it'd read the same whether the pass ran or not. This adds one
        // (`RAN_THE_PASS`) while keeping the task echo, so the assertion
        // below actually pins that the pass was never invoked.
        'echo "pass for 999: RAN_TH""E_PASS TASK=$DRIVE_PR_ROUND_TASK DETAIL=$DRIVE_PR_ROUND_TASK_DETAIL" >&2; exit 0',
      ],
      undefined,
      { env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" } },
    );
    expect(r.stderr).toContain(
      "(dry-run) would run a CI-repair pass for: code-quality-and-build",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
    expect(r.stderr).not.toContain("TASK=ci-repair");
  });

  it("does not spend CI-repair budget on a verdict that names no failing check", async () => {
    // `unknown:`/unreadable is an absence of evidence, not evidence of
    // failure — a /fix-ci pass handed no run and no check name has nothing to
    // work from, so this must take the stop directly even with budget left.
    const r = await runDrive(
      {
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM],
        statusesUnreadable: true,
      },
      ["--keep-draft", "--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { DRIVE_PR_CI_REPAIR_ROUNDS: "2" } },
    );
    expect(r.stderr).toContain("stopping for /fix-ci");
    expect(r.stderr).not.toContain("TASK=ci-repair");
    expect(r.exitCode).toBe(1);
  });

  it("never leaks a repair task into an ordinary review round", async () => {
    // An operator (or an outer driver) with the variable exported must not
    // turn a round that has live findings into a repair round — the pass
    // would skip triage entirely and leave those findings unanswered.
    const r = await runDrive(
      {
        threads: [{ id: "PRRT_leak", path: "a.ts", bot: true }],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
      },
      [
        "--keep-draft",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        ...PASS_TASK,
      ],
      undefined,
      {
        env: {
          DRIVE_PR_ROUND_TASK: "ci-repair",
          DRIVE_PR_ROUND_TASK_DETAIL: "inherited noise",
        },
      },
    );
    // The complete echoed line, not merely `toContain('TASK=')`: that
    // substring also matches `TASK=ci-repair`, so it cannot
    // tell a genuinely CLEARED pair from one the driver merely replaced with
    // some other non-empty noise — only pinning both variables empty proves
    // the leak is closed, not just that these two particular values didn't
    // survive.
    expect(r.stderr).toContain("pass for 999: TASK= DETAIL=");
    expect(r.stderr).not.toContain("TASK=ci-repair");
    expect(r.stderr).not.toContain("DETAIL=inherited noise");
  });

  it("stops for /fix-ci when the unlabel-triggered full-CI witness completed red", async () => {
    const failing: CheckRunFixture = {
      name: "code-quality-and-build",
      status: "completed",
      conclusion: "failure",
      app: "github-actions",
      started: "2026-09-10T10:01:00Z",
    };
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [REVIEWER_RUN, DORMANT_ARM, failing],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([
        {
          node_id: "LE_1",
          event: "labeled",
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at: "2026-09-10T09:59:00Z",
        },
      ]),
    );
    const seeded = await state(
      stateDir,
      [
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_1",
        "--head",
        scratchClean.head,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T09:59:00Z",
        "--check-run-watermark",
        "10000",
      ],
      scratchClean.dir,
    );
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--keep-draft", "--no-head-sync", "--", ...PASS_LOUD],
      undefined,
      { env: NO_REPAIR },
    );
    expect(r.stderr).toContain("stopping for /fix-ci");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain("RAN_THE_PASS");
  });

  it("does not retry forever when a post-unlabel cascade leaves required jobs skipped and something else red", async () => {
    // The shape: `detect-changes` fails after the unlabel, cascading the
    // required `code-quality-and-build`/`tests` into `skipped`.
    // `completedRequiredCi` correctly refuses a skipped run as a witness, so
    // `final-ready` returns 4. Taking that 4 as "still pending" sleeps
    // forever; the driver must instead decide on a fresh aggregate, not on a
    // pre-unlabel `status.ci` snapshot.
    //
    // `skipped` is deliberately PASSING to the aggregate verdict, so the red
    // here has to come from the job that actually failed — which is precisely
    // why the decision rests on the fresh aggregate rather than on exit 4.
    const cascade: CheckRunFixture[] = [
      {
        name: "detect-changes",
        status: "completed",
        conclusion: "failure",
        app: "github-actions",
        started: "2026-09-10T10:01:00Z",
      },
      {
        name: "code-quality-and-build",
        status: "completed",
        conclusion: "skipped",
        app: "github-actions",
        started: "2026-09-10T10:01:00Z",
      },
      {
        name: "tests",
        status: "completed",
        conclusion: "skipped",
        app: "github-actions",
        started: "2026-09-10T10:01:00Z",
      },
    ];
    const { dir, stateDir } = writeFixture({
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      ciHeld: true,
      checkRuns: [REVIEWER_RUN, DORMANT_ARM, ...cascade],
    });
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([
        {
          node_id: "LE_1",
          event: "labeled",
          label: { name: "ci:hold" },
          actor: { login: "drive-user" },
          created_at: "2026-09-10T09:59:00Z",
        },
      ]),
    );
    const seeded = await state(
      stateDir,
      [
        "set-ci-hold",
        "999",
        "--set",
        "held",
        "--event-id",
        "LE_1",
        "--head",
        scratchClean.head,
        "--actor-name",
        "drive-user",
        "--created-at",
        "2026-09-10T09:59:00Z",
        "--check-run-watermark",
        "10000",
      ],
      scratchClean.dir,
    );
    expect(seeded.exitCode).toBe(0);
    rmSync(join(scratchClean.dir, ".context"), {
      recursive: true,
      force: true,
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--keep-draft", "--no-head-sync", "--", ...PASS_LOUD],
      undefined,
      // Repair disabled so this pins the DECISION (stop vs retry forever)
      // rather than the repair layered on top of it.
      { env: NO_REPAIR },
    );
    // The point of the test: it TERMINATES, with the red named. Against the
    // unfixed code this run never returns at all.
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("stopping for /fix-ci");
    expect(r.stderr).toContain("detect-changes");
  });

  it("failingNames returns the individual failing check-run and commit-status names, unparsed", () => {
    // The structured counterpart to `ciVerdictOf`'s rendered string. Added
    // because a caller testing exact membership (`REQUIRED_FULL_CI_CHECKS`)
    // against that string's `; `/`, `-joined output cannot round-trip a
    // check name that itself contains either delimiter: a non-required
    // check literally named "Schema gate, shard 1" would split into
    // ['Schema gate', 'shard 1'] and falsely satisfy an exact-match test
    // against the required 'Schema gate'. This function sidesteps the whole
    // class by never joining and re-splitting in the first place.
    const run = (
      name: string,
      conclusion: string | null,
    ): EvidenceCheckRun => ({
      name,
      status: conclusion === null ? "in_progress" : "completed",
      conclusion,
      app: "github-actions",
      title: "",
      id: 1,
      started: "2026-09-10T10:00:00Z",
    });
    const status = (context: string, state: string): EvidenceCommitStatus => ({
      context,
      state,
      description: null,
    });

    expect(failingNames([run("Schema gate", "failure")], [], false)).toEqual([
      "Schema gate",
    ]);
    // The exact adversarial shape: a check whose
    // OWN name contains the delimiter `ciVerdictOf` joins on. Returned
    // intact, never split.
    expect(
      failingNames([run("Schema gate, shard 1", "failure")], [], false),
    ).toEqual(["Schema gate, shard 1"]);
    // Both groups — check-runs and legacy commit statuses — contribute,
    // each name exact and unsplit.
    expect(
      failingNames(
        [run("code-quality-and-build", "failure")],
        [status("ctx1", "failure")],
        false,
      ),
    ).toEqual(["code-quality-and-build", "ctx1"]);
    // Passing conclusions never appear.
    expect(failingNames([run("tests", "success")], [], false)).toEqual([]);
    // Unreadable evidence is `null`, never a guessed empty array — the same
    // "absence of evidence is not evidence of a clean set" rule `ciVerdictOf`
    // itself follows for its `unknown:` cases.
    expect(failingNames([], null, false)).toBeNull();
    expect(failingNames([], [], true)).toBeNull();
  });

  it("failingStatusNames returns the commit-status-only complement of failingCheckRunNames", () => {
    const status = (context: string, state: string): EvidenceCommitStatus => ({
      context,
      state,
      description: null,
    });
    expect(failingStatusNames([status("Schema gate", "failure")])).toEqual([
      "Schema gate",
    ]);
    // A name shared with a failing check-run still appears here — this
    // function knows nothing about check-runs at all, which is the whole
    // point: it is the independent, check-run-blind witness `drive.ts` needs
    // to tell a purely check-run-sourced required failure from one that ALSO
    // has a fresh, unambiguous status occurrence under the same name.
    expect(
      failingStatusNames([
        status("Schema gate", "failure"),
        status("other-context", "error"),
      ]),
    ).toEqual(["Schema gate", "other-context"]);
    // Passing/pending states never appear.
    expect(
      failingStatusNames([
        status("ok", "success"),
        status("still-running", "pending"),
      ]),
    ).toEqual([]);
    // Unreadable evidence is `null`, never a guessed empty array.
    expect(failingStatusNames(null)).toBeNull();
  });

  it.skipIf(skipLongDriveFixture)(
    "treats a mixed verdict as actionable when only one failing name is a stale required check",
    async () => {
      // The general form of the cascade above, but with the required
      // check ALSO failing rather than skipped — the exact shape
      // `failing: Schema gate, detect-changes` with
      // `finalCi.code === 4`. The old `.some()` predicate read ANY required
      // name in the verdict as proof the WHOLE verdict was unreliable,
      // deferring `detect-changes` — a definitively fresh, non-required
      // failure — to the witness wait right alongside the ambiguous `Schema
      // gate` one, contradicting the neighbouring comment's own stated intent
      // that a non-required failure "is trusted immediately". Fixed, the
      // verdict is stale only when EVERY failing name is required, so this
      // mixed case is dispatched as an ordinary CI-repair instead.
      const mixed: CheckRunFixture[] = [
        {
          name: "Schema gate",
          status: "completed",
          conclusion: "failure",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
        {
          name: "detect-changes",
          status: "completed",
          conclusion: "failure",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
      ];
      const { dir, stateDir } = writeFixture({
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        ciHeld: true,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, ...mixed],
      });
      writeFileSync(
        join(dir, "timeline.json"),
        JSON.stringify([
          {
            node_id: "LE_1",
            event: "labeled",
            label: { name: "ci:hold" },
            actor: { login: "drive-user" },
            created_at: "2026-09-10T09:59:00Z",
          },
        ]),
      );
      const seeded = await state(
        stateDir,
        [
          "set-ci-hold",
          "999",
          "--set",
          "held",
          "--event-id",
          "LE_1",
          "--head",
          scratchClean.head,
          "--actor-name",
          "drive-user",
          "--created-at",
          "2026-09-10T09:59:00Z",
          "--check-run-watermark",
          "10000",
        ],
        scratchClean.dir,
      );
      expect(seeded.exitCode).toBe(0);
      rmSync(join(scratchClean.dir, ".context"), {
        recursive: true,
        force: true,
      });
      const r = await runDriveIn(
        dir,
        stateDir,
        [
          "--keep-draft",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          ...PASS_TASK,
        ],
        undefined,
        {
          env: {
            DRIVE_PR_CI_REPAIR_ROUNDS: "1",
            // Bounds a hypothetical regression to a fast failure instead of a
            // 30-minute hang: against the OLD `.some()` predicate this fixture
            // falls into the witness wait instead of dispatching a repair.
            DRIVE_PR_FINAL_CI_WITNESS_POLLS: "1",
          },
        },
      );
      expect(r.stderr).toContain("TASK=ci-repair");
      expect(r.stderr).toContain("DETAIL=Schema gate, detect-changes");
      expect(r.stderr).not.toContain(
        "no fresh exact-head required-check witness",
      );
    },
  );

  it("drive-status.ts's --json output actually carries failingCheckNames/failingCheckRunNames/failingStatusNames", async () => {
    // `evaluate()` computed both fields on its internal report object, but
    // the CLI's own `emit()` never included either in the
    // hand-built JSON payload — so every consumer reading
    // `finalStatus.failingCheckNames`/`failingCheckRunNames` (drive.ts) saw
    // `undefined` in production, no matter how carefully the predicate that
    // reads them was tuned. Pinned directly against the real subprocess
    // output rather than only through drive.ts's own end-to-end behavior, so
    // a future refactor of emit()'s payload cannot silently drop the field
    // again without this failing. `failingStatusNames` gets the
    // identical pin for the same reason — the provenance fix in drive.ts is
    // only real if this field actually reaches the CLI boundary.
    const { dir, stateDir } = writeFixture({
      threads: [],
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        {
          name: "Schema gate",
          status: "completed",
          conclusion: "failure",
          app: "github-actions",
          started: "2026-09-10T10:01:00Z",
        },
      ],
      statuses: [{ context: "legacy-ctx", state: "failure", description: "" }],
    });
    const r = await probeIn(dir, stateDir);
    expect(r.json.failingCheckNames).toEqual(["Schema gate", "legacy-ctx"]);
    expect(r.json.failingCheckRunNames).toEqual(["Schema gate"]);
    expect(r.json.failingStatusNames).toEqual(["legacy-ctx"]);
  });
});
