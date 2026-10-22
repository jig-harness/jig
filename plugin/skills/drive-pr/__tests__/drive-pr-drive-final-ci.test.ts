/**
 * drive-pr suite: drive.ts on a red final CI verdict — the /fix-ci stop, the
 * CI-repair round and its budget, the unlabel-triggered witness, and the
 * failing-check names a verdict carries.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CheckRun as EvidenceCheckRun,
  CommitStatus as EvidenceCommitStatus,
} from "../scripts/lib/status/evidence";
import {
  failingNames,
  failingStatusNames,
} from "../scripts/lib/status/evidence";

import {
  type CheckRunFixture,
  REVIEWER_RUN,
  DORMANT_ARM,
  scratchClean,
  writeFixture as rawFixture,
  probeIn,
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

  it("falls back to the /fix-ci stop once the CI-repair budget is spent", async () => {
    // The pass exits 0 but changes nothing, so the drive re-gates onto the
    // identical red verdict. Budget 1 means exactly one repair, then the stop.
    const r = await runDrive(
      {
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
      },
      ["--keep-draft", "--no-head-sync", "--", ...PASS_TASK],
      undefined,
      { env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" } },
    );
    expect(r.stderr).toContain("Running CI-repair pass 1/1");
    expect(r.stderr).toContain("stopping for /fix-ci");
    expect(r.stderr).toContain("the budget is spent");
    expect(r.exitCode).toBe(1);
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
        'echo "pass for 999: RAN_THE_PASS TASK=$DRIVE_PR_ROUND_TASK DETAIL=$DRIVE_PR_ROUND_TASK_DETAIL" >&2; exit 0',
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
