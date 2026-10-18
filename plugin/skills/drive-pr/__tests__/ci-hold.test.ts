import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import {
  ciHoldTransitions,
  completedHoldPrecondition,
  completedRequiredCi,
  mutationProven,
  newestCiHoldTransition,
  ownsHeldTransition,
  parseCheckRuns,
  parsePrSnapshot,
} from "../scripts/lib/ci-hold.ts";
import { stateDirIdentityToken } from "../scripts/lib/state/lease.ts";
import { freshState, isUsableState } from "../scripts/lib/state/schema.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/** The hold label and required checks of the suite's consumer configuration. */
const HOLD = "ci:hold";
const REQUIRED = ["code-quality-and-build", "tests", "Schema gate"];
/** The drive suite's consumer configuration, which declares both. */
const HOLD_OVERLAY = join(import.meta.dir, "fixtures", "overlay.yaml");
/** One required check on its own, for the single-check freshness cases. */
const WITNESS = ["Schema gate"];

function writeGhStub(path: string, body: string): void {
  const guard = `#!/usr/bin/env bash
case "$1 $2" in
  'pr view')
    [[ "$3" == 999 ]] || { echo 'gh: pr view expected PR selector 999' >&2; exit 2; }
    [[ "$4" == --json ]] || { echo 'gh: expected --json state,headRefOid,labels' >&2; exit 2; }
    [[ -n "\${5:-}" ]] || { echo 'gh: missing flag value' >&2; exit 2; }
    [[ "$5" == 'state,headRefOid,labels' ]] || { echo 'gh: expected --json state,headRefOid,labels' >&2; exit 2; }
    [[ "$#" -eq 5 ]] || { echo 'gh: unexpected pr view arguments' >&2; exit 2; }
    ;;
  'pr edit')
    [[ "$3" == 999 ]] || { echo 'gh: pr edit expected PR selector 999' >&2; exit 2; }
    [[ "$#" -eq 5 && ( "$4" == --add-label || "$4" == --remove-label ) ]] || {
      echo 'gh: expected exactly one hold label operation' >&2; exit 2;
    }
    [[ "$5" == ci:hold ]] || { echo "gh: unexpected hold label: $5" >&2; exit 2; }
    ;;
  'api user')
    [[ "$#" -eq 4 && "$3" == -q && "$4" == .login ]] || {
      echo 'gh: unexpected user lookup arguments' >&2; exit 2;
    }
    ;;
  'api --paginate')
    [[ "$#" -eq 4 && "$3" == --slurp ]] || {
      echo 'gh: expected --paginate --slurp for evidence endpoint' >&2; exit 2;
    }
    case "$4" in
      'repos/{owner}/{repo}/issues/999/timeline?per_page=100'|\
      'repos/example-org/example-repo/issues/999/timeline?per_page=100'|\
      'repos/{owner}/{repo}/commits/${HEAD}/check-runs?per_page=100'|\
      'repos/example-org/example-repo/commits/${HEAD}/check-runs?per_page=100'|\
      'repos/{owner}/{repo}/commits/${HEAD}/status?per_page=100'|\
      'repos/example-org/example-repo/commits/${HEAD}/status?per_page=100') ;;
      *) echo "gh: unsupported api endpoint: $4" >&2; exit 2 ;;
    esac
    ;;
  'api '*) echo 'gh: expected --paginate --slurp for evidence endpoint' >&2; exit 2 ;;
  *) echo "unexpected fake gh command: $*" >&2; exit 2 ;;
esac
`;
  writeFakeProgram(path, guard + body);
}

describe("ci:hold evidence", () => {
  it("the fake gh requires the snapshot field projection", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-hold-gh-projection-"));
    try {
      const path = join(dir, "gh");
      writeGhStub(path, "echo accepted\n");
      const wrong = Bun.spawnSync([
        path,
        "pr",
        "view",
        "999",
        "--json",
        "number",
      ]);
      expect(wrong.exitCode).toBe(2);
      expect(wrong.stderr.toString()).toContain(
        "expected --json state,headRefOid,labels",
      );
      const correct = Bun.spawnSync([
        path,
        "pr",
        "view",
        "999",
        "--json",
        "state,headRefOid,labels",
      ]);
      expect(correct.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fake gh rejects a PR selector outside its fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-hold-gh-selector-"));
    try {
      const path = join(dir, "gh");
      writeGhStub(path, "echo accepted\n");
      const result = Bun.spawnSync([
        path,
        "pr",
        "view",
        "998",
        "--json",
        "state,headRefOid,labels",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("expected PR selector 999");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fake gh rejects a snapshot selected from another repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-hold-gh-pr-repo-"));
    try {
      const path = join(dir, "gh");
      writeGhStub(path, "echo accepted\n");
      const result = Bun.spawnSync([
        path,
        "pr",
        "view",
        "999",
        "--repo",
        "other/repo",
        "--json",
        "state,headRefOid,labels",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout.toString()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fake gh rejects an empty flag value before serving a fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-hold-gh-empty-"));
    try {
      const path = join(dir, "gh");
      writeGhStub(path, "echo accepted\n");
      const result = Bun.spawnSync([path, "pr", "view", "999", "--json", ""]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("missing flag value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fake gh rejects a misspelled check-runs endpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-hold-gh-endpoint-"));
    try {
      const path = join(dir, "gh");
      writeGhStub(path, "echo accepted\n");
      const result = Bun.spawnSync([
        path,
        "api",
        "--paginate",
        "--slurp",
        `repos/{owner}/{repo}/commits/${HEAD}/check-runz?per_page=100`,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("unsupported api endpoint");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fake gh requires paginated, slurped evidence responses", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-hold-gh-pagination-"));
    try {
      const path = join(dir, "gh");
      writeGhStub(path, "echo accepted\n");
      for (const endpoint of [
        "repos/{owner}/{repo}/issues/999/timeline?per_page=100",
        `repos/{owner}/{repo}/commits/${HEAD}/check-runs?per_page=100`,
        `repos/example-org/example-repo/commits/${HEAD}/status?per_page=100`,
      ]) {
        for (const flags of [[], ["--paginate"], ["--slurp"]]) {
          const result = Bun.spawnSync([path, "api", ...flags, endpoint]);
          expect(result.exitCode).toBe(2);
          expect(result.stderr.toString()).toContain(
            "expected --paginate --slurp",
          );
        }
        const accepted = Bun.spawnSync([
          path,
          "api",
          "--paginate",
          "--slurp",
          endpoint,
        ]);
        expect(accepted.exitCode).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fake gh binds evidence responses to its PR and head SHA", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-hold-gh-identity-"));
    try {
      const path = join(dir, "gh");
      writeGhStub(path, "echo accepted\n");
      for (const endpoint of [
        "repos/{owner}/{repo}/issues/998/timeline?per_page=100",
        `repos/{owner}/{repo}/commits/${"b".repeat(40)}/check-runs?per_page=100`,
        `repos/example-org/example-repo/commits/${"b".repeat(40)}/status?per_page=100`,
      ]) {
        const result = Bun.spawnSync([
          path,
          "api",
          "--paginate",
          "--slurp",
          endpoint,
        ]);
        expect(result.exitCode).toBe(2);
        expect(result.stderr.toString()).toContain("unsupported api endpoint");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fake gh rejects check-run evidence from another repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-hold-gh-repo-"));
    try {
      const path = join(dir, "gh");
      writeGhStub(path, "echo accepted\n");
      const result = Bun.spawnSync([
        path,
        "api",
        "--paginate",
        "--slurp",
        `repos/other/repo/commits/${HEAD}/check-runs?per_page=100`,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("unsupported api endpoint");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fake gh rejects a different hold label", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-hold-gh-label-"));
    try {
      const path = join(dir, "gh");
      writeGhStub(path, "echo accepted\n");
      const result = Bun.spawnSync([
        path,
        "pr",
        "edit",
        "999",
        "--add-label",
        "other-label",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("unexpected hold label");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fake gh requires exactly one hold label operation", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-hold-gh-edit-operation-"));
    try {
      const path = join(dir, "gh");
      writeGhStub(path, "echo accepted\n");
      for (const args of [
        ["pr", "edit", "999"],
        [
          "pr",
          "edit",
          "999",
          "--add-label",
          "ci:hold",
          "--remove-label",
          "ci:hold",
        ],
      ]) {
        const result = Bun.spawnSync([path, ...args]);
        expect(result.exitCode).toBe(2);
        expect(result.stderr.toString()).toContain(
          "expected exactly one hold label operation",
        );
      }
      for (const operation of ["--add-label", "--remove-label"]) {
        const result = Bun.spawnSync([
          path,
          "pr",
          "edit",
          "999",
          operation,
          "ci:hold",
        ]);
        expect(result.exitCode).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds finish-round hold acquisition to the exact pushed head", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "scripts", "finish-round.ts"),
      "utf8",
    );
    expect(source).toContain(
      'tsArgv(ciHold, ["ensure", pr, "--expect-head", report.head])',
    );
  });

  it("uses the newest matching timeline transition as the ownership token", () => {
    expect(
      newestCiHoldTransition(
        [
          {
            id: 1,
            node_id: "LE_1",
            event: "labeled",
            label: { name: "ci:hold" },
            actor: { login: "drive" },
            created_at: "2026-09-10T10:00:00Z",
          },
          {
            id: 2,
            node_id: "LE_2",
            event: "unlabeled",
            label: { name: "ci:hold" },
            actor: { login: "human" },
            created_at: "2026-09-10T10:01:00Z",
          },
          {
            id: 3,
            event: "labeled",
            label: { name: "unrelated" },
            actor: { login: "drive" },
            created_at: "2026-09-10T10:02:00Z",
          },
        ],
        HOLD,
      ),
    ).toEqual({
      id: "LE_2",
      event: "unlabeled",
      actor: "human",
      createdAt: "2026-09-10T10:01:00Z",
    });
  });

  it("fails closed when a labelled timeline event is malformed", () => {
    expect(
      newestCiHoldTransition(
        [
          {
            node_id: "LE_owned",
            event: "labeled",
            label: { name: "ci:hold" },
            actor: { login: "drive" },
            created_at: "2026-09-10T10:00:00Z",
          },
          {
            node_id: "LE_unreadable",
            event: "labeled",
            label: { name: "ci:hold" },
            actor: null,
            created_at: "2026-09-10T10:01:00Z",
          },
        ],
        HOLD,
      ),
    ).toBeNull();
  });

  it("fails closed on a timeline entry that is not a proper object, rather than skipping it", () => {
    // A null/primitive/array timeline element could be obscuring a genuine
    // ci:hold transition this function has no way to inspect — skipping it
    // and continuing risks exposing an older event as "latest" and letting
    // release() remove a label that now belongs to another actor.
    for (const malformed of [null, "not-an-object", 42, [], [1, 2]]) {
      expect(
        ciHoldTransitions(
          [
            {
              node_id: "LE_owned",
              event: "labeled",
              label: { name: "ci:hold" },
              actor: { login: "drive" },
              created_at: "2026-09-10T10:00:00Z",
            },
            malformed,
          ],
          HOLD,
        ),
      ).toBeNull();
    }
    // An array whose OWN elements are otherwise well-formed events must
    // still fail closed — arrays are not valid timeline entries at all,
    // regardless of what they contain.
    expect(
      ciHoldTransitions(
        [
          {
            node_id: "LE_owned",
            event: "labeled",
            label: { name: "ci:hold" },
            actor: { login: "drive" },
            created_at: "2026-09-10T10:00:00Z",
          },
          [
            {
              node_id: "LE_hidden",
              event: "labeled",
              label: { name: "ci:hold" },
              actor: { login: "human" },
              created_at: "2026-09-10T10:01:00Z",
            },
          ],
        ],
        HOLD,
      ),
    ).toBeNull();
  });

  it("will not remove after a human remove/re-add replaces its ownership token", () => {
    const owned = {
      phase: "held" as const,
      eventId: "LE_owned",
      addedAtHead: HEAD,
    };
    expect(
      ownsHeldTransition(owned, {
        id: "LE_owned",
        event: "labeled",
        actor: "drive",
        createdAt: "2026-09-10T10:00:00Z",
      }),
    ).toBe(true);
    expect(
      ownsHeldTransition(owned, {
        id: "LE_human_readd",
        event: "labeled",
        actor: "human",
        createdAt: "2026-09-10T10:02:00Z",
      }),
    ).toBe(false);
  });

  it("accepts a proven mutation even when the transport exits nonzero", () => {
    const event = {
      id: "LE_applied_before_timeout",
      event: "labeled" as const,
      actor: "drive",
      createdAt: "2026-09-10T10:00:00Z",
    };
    expect(mutationProven(1, event, true)).toBe(true);
    expect(mutationProven(0, null, true)).toBe(false);
  });

  it("does not accept a skipped Schema gate as the final witness, even over an older success", () => {
    // The newest run (id 2, skipped) is selected first and validated on its own
    // terms — it does not qualify, and completedRequiredCi does NOT fall back
    // to the older, completed-success run behind it, with or without an unlabel
    // floor. Falling back to superseded evidence is exactly the class of bug
    // this guards against.
    const runs = parseCheckRuns({
      check_runs: [
        {
          id: 1,
          name: "Schema gate",
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
          created_at: "2026-09-10T09:59:00Z",
          started_at: "2026-09-10T09:59:00Z",
        },
        {
          id: 2,
          name: "Schema gate",
          head_sha: HEAD,
          status: "completed",
          conclusion: "skipped",
          created_at: "2026-09-10T10:01:00Z",
          started_at: "2026-09-10T10:01:00Z",
        },
      ],
    });
    expect(runs).not.toBeNull();
    expect(completedRequiredCi(runs ?? [], WITNESS, HEAD)).toBe(false);
    expect(
      completedRequiredCi(
        runs ?? [],
        WITNESS,
        HEAD,
        "2026-09-10T10:00:00Z",
        false,
      ),
    ).toBe(false);
  });

  it("accepts a non-skipped exact-head Schema gate after the unlabel", () => {
    const runs = parseCheckRuns([
      {
        check_runs: [
          {
            id: 3,
            name: "Schema gate",
            head_sha: HEAD,
            status: "completed",
            conclusion: "success",
            created_at: "2026-09-10T10:00:00Z",
            started_at: "2026-09-10T10:00:00Z",
          },
        ],
      },
    ]);
    expect(
      completedRequiredCi(
        runs ?? [],
        WITNESS,
        HEAD,
        "2026-09-10T10:00:00Z",
        false,
      ),
    ).toBe(true);
  });

  it("parses the production check-runs shape without a nonexistent created_at field", () => {
    expect(
      parseCheckRuns({
        check_runs: [
          {
            id: 30,
            name: "Schema gate",
            head_sha: HEAD,
            status: "completed",
            conclusion: "success",
            started_at: "2026-09-10T10:00:00Z",
            completed_at: "2026-09-10T10:01:00Z",
          },
        ],
      }),
    ).toEqual([
      {
        id: 30,
        name: "Schema gate",
        headSha: HEAD,
        status: "completed",
        conclusion: "success",
        startedAt: "2026-09-10T10:00:00Z",
        appId: null,
      },
    ]);
  });

  it("treats a fresh failed Schema gate as completed rerun evidence", () => {
    const runs = parseCheckRuns({
      check_runs: [
        {
          id: 4,
          name: "Schema gate",
          head_sha: HEAD,
          status: "completed",
          conclusion: "failure",
          created_at: "2026-09-10T10:01:00Z",
          started_at: "2026-09-10T10:01:00Z",
        },
      ],
    });
    expect(
      completedRequiredCi(
        runs ?? [],
        WITNESS,
        HEAD,
        "2026-09-10T10:00:00Z",
        false,
      ),
    ).toBe(true);
  });

  it("rejects a run queued before unlabel even when it starts afterward", () => {
    const runs = parseCheckRuns({
      check_runs: [
        {
          id: 40,
          name: "Schema gate",
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
          created_at: "2026-09-10T09:59:59Z",
          started_at: "2026-09-10T10:00:01Z",
        },
      ],
    });
    expect(
      completedRequiredCi(
        runs ?? [],
        WITNESS,
        HEAD,
        "2026-09-10T10:00:00Z",
        false,
        40,
      ),
    ).toBe(false);
  });

  it("uses the run-id watermark to order same-second unlabel evidence", () => {
    const runs = parseCheckRuns({
      check_runs: [
        {
          id: 41,
          name: "Schema gate",
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
          created_at: "2026-09-10T10:00:00Z",
          started_at: "2026-09-10T10:00:00Z",
        },
      ],
    });
    expect(
      completedRequiredCi(
        runs ?? [],
        WITNESS,
        HEAD,
        "2026-09-10T10:00:00Z",
        false,
        40,
      ),
    ).toBe(true);
  });

  it("requires a strictly later start when no pre-unlabel watermark survived", () => {
    const runs = parseCheckRuns({
      check_runs: [
        {
          id: 41,
          name: "Schema gate",
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
          started_at: "2026-09-10T10:00:00Z",
        },
      ],
    });
    expect(
      completedRequiredCi(
        runs ?? [],
        WITNESS,
        HEAD,
        "2026-09-10T10:00:00Z",
        false,
        0,
        true,
      ),
    ).toBe(false);
  });

  it("requires every branch-protection check before acquiring the first hold", () => {
    const runs = parseCheckRuns({
      check_runs: ["code-quality-and-build", "tests", "Schema gate"].map(
        (name, index) => ({
          id: index + 1,
          name,
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
          created_at: "2026-09-10T10:00:00Z",
          started_at: "2026-09-10T10:00:00Z",
        }),
      ),
    });
    expect(completedRequiredCi(runs ?? [], REQUIRED, HEAD)).toBe(true);
    expect(completedRequiredCi((runs ?? []).slice(1), REQUIRED, HEAD)).toBe(
      false,
    );
  });

  it("waits for a newer queued rerun rather than falling back to an older success", () => {
    // An earlier fix closed a masking bug by filtering to qualifying
    // (completed, non-skipped, fresh) runs BEFORE picking the highest id — but
    // that same filter can silently prefer an older, already-successful run
    // over a newer, genuine RERUN of the identical check that is still queued
    // or in-progress and could yet fail. The newest run is the only evidence
    // that can still change, so completedRequiredCi must select it FIRST,
    // unconditionally, and validate freshness/completion/success on THAT run
    // alone — never falling back to an older one it superseded.
    const runs = parseCheckRuns({
      check_runs: [
        {
          id: 1,
          name: "code-quality-and-build",
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
          started_at: "2026-09-10T10:00:00Z",
        },
        {
          id: 2,
          name: "tests",
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
          started_at: "2026-09-10T10:00:00Z",
        },
        // An older, completed, successful Schema gate run...
        {
          id: 3,
          name: "Schema gate",
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
          started_at: "2026-09-10T10:00:00Z",
        },
        // ...superseded by a NEWER rerun that is still queued and might fail.
        {
          id: 4,
          name: "Schema gate",
          head_sha: HEAD,
          status: "queued",
          conclusion: null,
          started_at: null,
        },
      ],
    });
    expect(completedRequiredCi(runs ?? [], REQUIRED, HEAD)).toBe(false);
    // Once the newest run itself concludes successfully, the check qualifies.
    const resolved = parseCheckRuns({
      check_runs: [
        ...(runs ?? []).slice(0, 3).map((r) => ({
          id: r.id,
          name: r.name,
          head_sha: r.headSha,
          status: r.status,
          conclusion: r.conclusion,
          started_at: r.startedAt,
        })),
        {
          id: 4,
          name: "Schema gate",
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
          started_at: "2026-09-10T10:05:00Z",
        },
      ],
    });
    expect(completedRequiredCi(resolved ?? [], REQUIRED, HEAD)).toBe(true);
  });

  it("fails closed on malformed PR label entries", () => {
    expect(
      parsePrSnapshot(
        { state: "OPEN", headRefOid: HEAD, labels: [null] },
        HOLD,
      ),
    ).toBeNull();
    expect(
      parsePrSnapshot(
        {
          state: "OPEN",
          headRefOid: HEAD,
          labels: [{ name: "ci:hold" }],
        },
        HOLD,
      ),
    ).toEqual({ state: "OPEN", head: HEAD, held: true });
  });

  it("does not re-add after an unlabel until its Schema gate completes", () => {
    const runs = parseCheckRuns({
      check_runs: [
        {
          id: 5,
          name: "Schema gate",
          head_sha: HEAD,
          status: "completed",
          conclusion: "failure",
          created_at: "2026-09-10T09:59:00Z",
          started_at: "2026-09-10T09:59:00Z",
        },
      ],
    });
    const unlabel = {
      id: "LE_unlabel",
      event: "unlabeled" as const,
      actor: "human",
      createdAt: "2026-09-10T10:00:00Z",
    };
    expect(completedHoldPrecondition(runs ?? [], REQUIRED, HEAD, unlabel)).toBe(
      false,
    );
    expect(completedHoldPrecondition(runs ?? [], REQUIRED, HEAD, null)).toBe(
      false,
    );
  });

  it("gives the composite helper enough time for every bounded sub-call", () => {
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-timeout-"));
    const fixture = join(root, "fixture.ts");
    const proc = join(import.meta.dir, "..", "scripts", "lib", "proc.ts");
    writeFileSync(
      fixture,
      `import { ciHoldTimeoutSeconds } from ${JSON.stringify(proc)}; process.stdout.write(String(ciHoldTimeoutSeconds()));`,
    );
    const result = Bun.spawnSync([process.execPath, fixture], {
      env: {
        ...process.env,
        DRIVE_PR_HELPER_TIMEOUT: "120",
        GH_CALL_TIMEOUT: "30",
        GIT_CALL_TIMEOUT: "30",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const expected = 1200 + 20 * 30 + 30 + 22 * 2 + 6;
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe(String(expected));
    rmSync(root, { recursive: true, force: true });
  });
});

describe("drive-state final verification", () => {
  function fakeGh(
    head: string,
    labels: string,
    state = "OPEN",
  ): {
    bin: string;
    stateDir: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr) printf '%s\\n' '{"state":"${state}","headRefOid":"${head}","labels":${labels}}' ;;
  api)
    case "$*" in
      *timeline*) printf '%s\\n' '[[]]' ;;
      *'/status?'*) printf '%s\\n' '[{"statuses":[]}]' ;;
      *) printf '%s\\n' '[{"check_runs":[
        {"id":1,"name":"code-quality-and-build","head_sha":"${head}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":2,"name":"tests","head_sha":"${head}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":3,"name":"Schema gate","head_sha":"${head}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"}
      ]}]' ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    return { bin, stateDir };
  }

  function invoke(
    bin: string,
    stateDir: string,
    args: string[],
  ): ReturnType<typeof Bun.spawnSync> {
    return Bun.spawnSync(
      scriptArgv(
        join(import.meta.dir, "..", "scripts", "drive-state.ts"),
        ...args,
      ),
      {
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          JIG_OVERLAY: HOLD_OVERLAY,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
          // set-ci-hold is test-only fixture seeding —
          // harmless to set unconditionally here since no other command
          // reads this variable.
          DRIVE_PR_ALLOW_TEST_CI_HOLD_SEED: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  }

  it("refuses to globally verify a held head", () => {
    const { bin, stateDir } = fakeGh(HEAD, '[{"name":"ci:hold"}]');
    const result = invoke(bin, stateDir, [
      "set-verified",
      "999",
      "--sha",
      HEAD,
    ]);
    expect(result.exitCode).toBe(4);
  });

  it("refuses to globally verify a stale or non-open head", () => {
    const stale = fakeGh(HEAD, "[]");
    expect(
      invoke(stale.bin, stale.stateDir, [
        "set-verified",
        "999",
        "--sha",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ]).exitCode,
    ).toBe(4);
    const closed = fakeGh(HEAD, "[]", "CLOSED");
    expect(
      invoke(closed.bin, closed.stateDir, [
        "set-verified",
        "999",
        "--sha",
        HEAD,
      ]).exitCode,
    ).toBe(5);
  });

  it("records an unheld exact head only with a successful Schema gate", () => {
    const { bin, stateDir } = fakeGh(HEAD, "[]");
    const result = invoke(bin, stateDir, [
      "set-verified",
      "999",
      "--sha",
      HEAD,
    ]);
    expect(result.exitCode).toBe(0);
    const read = invoke(bin, stateDir, ["verified", "999"]);
    expect(new TextDecoder().decode(read.stdout).trim()).toBe(HEAD);
  });

  it("clears the certificate when the head moves immediately after the verification commit", () => {
    // `pr view` answers HEAD for the entry and pre-commit re-checks, then a
    // DIFFERENT head from the third call onward — modeling a push landing in
    // the window between the last remote read and store.update() writing
    // verifiedSha. Neither read sees it; only the post-write compensating
    // check does.
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-race-write-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    const counter = join(root, "pr-view-calls");
    writeFileSync(counter, "0");
    const otherHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr)
    n=$(cat ${counter})
    echo $((n + 1)) > ${counter}
    if [ "$n" -lt 2 ]; then
      printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}'
    else
      printf '%s\\n' '{"state":"OPEN","headRefOid":"${otherHead}","labels":[]}'
    fi
    ;;
  api)
    case "$*" in
      *timeline*) printf '%s\\n' '[[]]' ;;
      *'/status?'*) printf '%s\\n' '[{"statuses":[]}]' ;;
      *) printf '%s\\n' '[{"check_runs":[
        {"id":1,"name":"code-quality-and-build","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":2,"name":"tests","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":3,"name":"Schema gate","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"}
      ]}]' ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    const result = invoke(bin, stateDir, [
      "set-verified",
      "999",
      "--sha",
      HEAD,
    ]);
    expect(result.exitCode).toBe(4);
    const read = invoke(bin, stateDir, ["verified", "999"]);
    expect(new TextDecoder().decode(read.stdout).trim()).toBe("");
  });

  it("clears the certificate when the label timeline changes immediately after the verification commit", () => {
    // Same class as the head-race test above, but for the OTHER half of
    // "still current": the pre-write and post-write checks used to ask
    // different questions — state/head/held only after the write, state/
    // head/held/timeline before it — so a human remove/re-add/remove of
    // ci:hold landing between the pre-write check and the write itself
    // left `verifiedSha` set over a transition ci-hold.ts final-ready would
    // now reject. `pr view` stays constant (head never moves); only the
    // label timeline changes, from the second `api ... timeline` call
    // onward.
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-race-timeline-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    const counter = join(root, "timeline-calls");
    writeFileSync(counter, "0");
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr) printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}' ;;
  api)
    case "$*" in
      *timeline*)
        n=$(cat ${counter})
        echo $((n + 1)) > ${counter}
        if [ "$n" -lt 2 ]; then
          printf '%s\\n' '[[]]'
        else
          printf '%s\\n' '[[{"node_id":"LE_new","event":"labeled","label":{"name":"ci:hold"},"actor":{"login":"human"},"created_at":"2026-09-10T10:02:00Z"}]]'
        fi
        ;;
      *'/status?'*) printf '%s\\n' '[{"statuses":[]}]' ;;
      *) printf '%s\\n' '[{"check_runs":[
        {"id":1,"name":"code-quality-and-build","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":2,"name":"tests","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":3,"name":"Schema gate","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"}
      ]}]' ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    const result = invoke(bin, stateDir, [
      "set-verified",
      "999",
      "--sha",
      HEAD,
    ]);
    expect(result.exitCode).toBe(4);
    const read = invoke(bin, stateDir, ["verified", "999"]);
    expect(new TextDecoder().decode(read.stdout).trim()).toBe("");
  });

  it("refuses when a required check is rerun and fails after the initial CI-evidence snapshot", () => {
    // The ORIGINAL `verdict` (ciVerdictOf over the first-fetched allRuns/
    // statuses) is exactly as stale as the head/timeline reads it sits beside
    // once real time elapses — a required check rerun and failed after that
    // snapshot but before the pre-write confirmation left `verifiedSha`
    // recorded from evidence that was no longer current, because
    // `stillFullyCurrent()` re-checked state/head/held/timeline but never
    // re-fetched CI evidence itself. `pr view` and the timeline stay constant;
    // only the check-runs endpoint answers differently, green for the first two
    // calls (the witness/requiredFresh read, then the initial ciVerdictOf
    // snapshot) and failing from the third call onward (stillFullyCurrent's own
    // re-checks).
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-race-ci-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    const counter = join(root, "check-runs-calls");
    writeFileSync(counter, "0");
    const greenRuns = `[{"check_runs":[
        {"id":1,"name":"code-quality-and-build","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":2,"name":"tests","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":3,"name":"Schema gate","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"}
      ]}]`;
    const redRuns = `[{"check_runs":[
        {"id":1,"name":"code-quality-and-build","head_sha":"${HEAD}","status":"completed","conclusion":"failure","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":2,"name":"tests","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":3,"name":"Schema gate","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"}
      ]}]`;
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr) printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}' ;;
  api)
    case "$*" in
      *timeline*) printf '%s\\n' '[[]]' ;;
      *'/status?'*) printf '%s\\n' '[{"statuses":[]}]' ;;
      *)
        n=$(cat ${counter})
        echo $((n + 1)) > ${counter}
        if [ "$n" -lt 2 ]; then
          printf '%s\\n' '${greenRuns}'
        else
          printf '%s\\n' '${redRuns}'
        fi
        ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    const result = invoke(bin, stateDir, [
      "set-verified",
      "999",
      "--sha",
      HEAD,
    ]);
    expect(result.exitCode).toBe(4);
    const read = invoke(bin, stateDir, ["verified", "999"]);
    expect(new TextDecoder().decode(read.stdout).trim()).toBe("");
  });

  it("refuses when a required check is superseded by a newer SKIPPED run, even though the aggregate verdict alone would pass", () => {
    // An earlier re-check verified only the aggregate `ciVerdictOf(...) ===
    // 'green'`, which treats `skipped` as non-failing — so a newer SKIPPED run
    // for a required check could supersede the successful post-unlabel run
    // without the aggregate re-check ever noticing, even though
    // `completedRequiredCi`'s own freshness predicate (which explicitly
    // excludes `skipped` from what counts as "completed") would reject it.
    // `stillFullyCurrent()` now delegates to the SAME `proveCiGreen()` the
    // initial proof uses, so the stricter witness/freshness check runs on every
    // re-check too, not just the aggregate one.
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-race-skip-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    const counter = join(root, "check-runs-calls");
    writeFileSync(counter, "0");
    const greenRuns = `[{"check_runs":[
        {"id":1,"name":"code-quality-and-build","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":2,"name":"tests","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":3,"name":"Schema gate","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"}
      ]}]`;
    // A newer run (id 4 > id 2) for "tests" that is SKIPPED, not failed —
    // ciVerdictOf's aggregate verdict does not treat this as red, but
    // completedRequiredCi's newest-run selection excludes skipped runs from
    // counting as "completed" at all, so it must still refuse.
    const skippedRuns = `[{"check_runs":[
        {"id":1,"name":"code-quality-and-build","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":2,"name":"tests","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"},
        {"id":4,"name":"tests","head_sha":"${HEAD}","status":"completed","conclusion":"skipped","created_at":"2026-09-10T10:02:00Z","started_at":"2026-09-10T10:02:00Z"},
        {"id":3,"name":"Schema gate","head_sha":"${HEAD}","status":"completed","conclusion":"success","created_at":"2026-09-10T10:01:00Z","started_at":"2026-09-10T10:01:00Z"}
      ]}]`;
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr) printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}' ;;
  api)
    case "$*" in
      *timeline*) printf '%s\\n' '[[]]' ;;
      *'/status?'*) printf '%s\\n' '[{"statuses":[]}]' ;;
      *)
        n=$(cat ${counter})
        echo $((n + 1)) > ${counter}
        if [ "$n" -lt 2 ]; then
          printf '%s\\n' '${greenRuns}'
        else
          printf '%s\\n' '${skippedRuns}'
        fi
        ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    const result = invoke(bin, stateDir, [
      "set-verified",
      "999",
      "--sha",
      HEAD,
    ]);
    expect(result.exitCode).toBe(4);
    const read = invoke(bin, stateDir, ["verified", "999"]);
    expect(new TextDecoder().decode(read.stdout).trim()).toBe("");
  });

  it("makes ciHold required and validates every durable transition phase", () => {
    const missing = freshState(999) as Record<string, unknown>;
    delete missing.ciHold;
    expect(isUsableState(missing, 999)).toBe(false);
    const states = [
      {
        phase: "acquiring",
        previousEventId: null,
        head: HEAD,
        actor: "drive-user",
        createdAt: "2026-09-10T10:00:00Z",
        checkRunWatermark: 42,
      },
      {
        phase: "held",
        eventId: "123",
        addedAtHead: HEAD,
        actor: "drive-user",
        createdAt: "2026-09-10T10:00:00Z",
        checkRunWatermark: 42,
      },
      {
        phase: "releasing",
        heldEventId: "123",
        addedAtHead: HEAD,
        heldActor: "drive-user",
        heldCreatedAt: "2026-09-10T09:00:00Z",
        head: HEAD,
        actor: "drive-user",
        createdAt: "2026-09-10T10:00:00Z",
        checkRunWatermark: 42,
      },
      {
        phase: "released",
        eventId: "124",
        head: HEAD,
        actor: "drive-user",
        createdAt: "2026-09-10T10:00:00Z",
        checkRunWatermark: 42,
        source: "drive",
      },
      {
        phase: "released",
        eventId: "124",
        head: HEAD,
        actor: "human-user",
        createdAt: "2026-09-10T10:00:00Z",
        checkRunWatermark: 0,
        source: "external",
      },
    ];
    for (const ciHold of states) {
      const state = {
        ...freshState(999),
        ciHold,
      };
      expect(isUsableState(state, 999)).toBe(true);
    }
  });

  it("refuses to reset state while this drive still owns a live hold", () => {
    const { bin, stateDir } = fakeGh(HEAD, '[{"name":"ci:hold"}]');
    const held = invoke(bin, stateDir, [
      "set-ci-hold",
      "999",
      "--set",
      "held",
      "--event-id",
      "LE_owned",
      "--head",
      HEAD,
      "--actor-name",
      "drive-user",
      "--created-at",
      "2026-09-10T10:00:00Z",
      "--check-run-watermark",
      "42",
    ]);
    expect(held.exitCode).toBe(0);
    const reset = invoke(bin, stateDir, ["reset", "999"]);
    expect(reset.exitCode).toBe(9);
    const read = invoke(bin, stateDir, ["get", "999"]);
    expect(
      (JSON.parse(new TextDecoder().decode(read.stdout)) as { ciHold: unknown })
        .ciHold,
    ).not.toBeNull();
  });

  it("refuses to reset state holding a RELEASED ci:hold transition", () => {
    // GitHub's label timeline is immutable and cumulative: once ANY ci:hold
    // transition has happened for this PR, the remote timeline can never go
    // back to empty. Erasing the local `released` record would make
    // ci-hold.ts final-ready's no-persisted-hold branch reject every future
    // head forever (it only accepts a null ciHold when the timeline IS
    // empty) — the same root cause the now-removed `clear-ci-hold` command
    // had.
    const { bin, stateDir } = fakeGh(HEAD, "[]");
    const released = invoke(bin, stateDir, [
      "set-ci-hold",
      "999",
      "--set",
      "released",
      "--event-id",
      "LE_released",
      "--head",
      HEAD,
      "--actor-name",
      "drive-user",
      "--created-at",
      "2026-09-10T10:00:00Z",
      "--check-run-watermark",
      "42",
    ]);
    expect(released.exitCode).toBe(0);
    const reset = invoke(bin, stateDir, ["reset", "999"]);
    expect(reset.exitCode).toBe(9);
    const read = invoke(bin, stateDir, ["get", "999"]);
    expect(
      (JSON.parse(new TextDecoder().decode(read.stdout)) as { ciHold: unknown })
        .ciHold,
    ).not.toBeNull();
  });

  it("clear-ci-hold is removed: the command no longer exists", () => {
    // Unconditionally nulling ciHold created the identical permanent-4
    // deadlock as resetting over a released transition, and this command had
    // no callers anywhere in the skill — removed rather than fixed, per the
    // finding's own first suggested remedy.
    const { bin, stateDir } = fakeGh(HEAD, "[]");
    const result = invoke(bin, stateDir, ["clear-ci-hold", "999"]);
    expect(result.exitCode).not.toBe(0);
  });

  it("refuses to reset an UNREADABLE state file that still NAMES a ciHold record", () => {
    // A file that fails to PARSE is not evidence it held no ci:hold
    // transition — it is evidence this code cannot tell either way. Reset
    // exists to clear genuine corruption, but silently treating "unreadable"
    // the same as "absent" let a real held/released transition's only event
    // id be deleted right alongside whatever actually corrupted the file.
    // Scoped to files that
    // still visibly mention the `ciHold` key even though they don't fully
    // parse — see the sibling test just below for the case this must NOT
    // block (corruption with no ciHold evidence in it at all).
    const { bin, stateDir } = fakeGh(HEAD, "[]");
    writeFileSync(
      join(stateDir, "drive-pr-999.json"),
      '{"pr":999,"ciHold":{"phase":"held","eventId":"LE_1"',
    );
    const reset = invoke(bin, stateDir, ["reset", "999"]);
    expect(reset.exitCode).toBe(9);
    expect(
      new TextDecoder()
        .decode(reset.stderr)
        .includes("does not confirm the absence"),
    ).toBe(true);
    // The file itself is untouched — reset refused before deleting anything.
    expect(existsSync(join(stateDir, "drive-pr-999.json"))).toBe(true);
  });

  it("still allows reset over unreadable state that names no ciHold evidence at all", () => {
    // The other half of the same fix: an unparseable file whose corruption
    // has nothing to do with ci:hold must stay recoverable through reset —
    // that is reset's own documented purpose (see `drive-pr.test.ts`'s
    // "`reset` is the deliberate way out of a malformed state"). Blocking
    // this case too would have "fixed" the finding by breaking the recovery
    // path it was raised against in the first place.
    const { bin, stateDir } = fakeGh(HEAD, "[]");
    writeFileSync(join(stateDir, "drive-pr-999.json"), "not json at all");
    const reset = invoke(bin, stateDir, ["reset", "999"]);
    expect(reset.exitCode).toBe(0);
  });

  it("refuses to reset unreadable state whose ciHold key is JSON-escaped, not literal bytes", () => {
    // A raw byte-substring check for `"ciHold"` is defeated the moment the key
    // is escaped: `ciHold` decodes to the identical property name `ciHold` but
    // never contains the literal bytes `"ciHold"` anywhere in the file. An
    // earlier fix used exactly that substring check; this pins the escape-aware
    // string-literal scanner that replaced it.
    const { bin, stateDir } = fakeGh(HEAD, "[]");
    writeFileSync(
      join(stateDir, "drive-pr-999.json"),
      '{"pr":999,"\\u0063iHold":{"phase":"held","eventId":"LE_1"',
    );
    const reset = invoke(bin, stateDir, ["reset", "999"]);
    expect(reset.exitCode).toBe(9);
    expect(existsSync(join(stateDir, "drive-pr-999.json"))).toBe(true);
  });

  it('still allows reset when "ciHold" appears only as a VALUE, not a property key', () => {
    // A literal decoding to `ciHold` in VALUE position — `{"reason":
    // "ciHold","broken":` — is not evidence of a `ciHold` property at all; an
    // earlier scanner credited any matching literal regardless of position,
    // over-blocking reset for corruption that never actually named the key.
    // Only a literal immediately followed by (optional whitespace, then) `:`
    // counts as a key.
    const { bin, stateDir } = fakeGh(HEAD, "[]");
    writeFileSync(
      join(stateDir, "drive-pr-999.json"),
      '{"reason":"ciHold","broken":',
    );
    const reset = invoke(bin, stateDir, ["reset", "999"]);
    expect(reset.exitCode).toBe(0);
  });

  it("refuses to reset a PERFECTLY PARSEABLE state file whose `ciHold` key is simply missing, when GitHub still shows a live transition", () => {
    // Earlier fixes each closed this only for the UNPARSEABLE-text path — but a
    // state file with no `ciHold` key at all still parses cleanly as valid
    // JSON, takes the `try` branch, and previously produced neither
    // `ownsCiHold` nor `hasCiHoldEvidence` — reset proceeded without ever
    // consulting the live timeline. Structurally identical risk to the
    // truncated-text case: local bytes cannot distinguish "never held" from
    // "the field was lost/never written".
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-reset-nokey-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr) printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}' ;;
  api)
    case "$*" in
      *timeline*) printf '%s\\n' '[[{"event":"labeled","label":{"name":"ci:hold"},"actor":{"login":"drive-user"},"node_id":"LE_live","created_at":"2026-09-10T10:00:00Z"}]]' ;;
      *) printf '%s\\n' '[]' ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    writeFileSync(
      join(stateDir, "drive-pr-999.json"),
      JSON.stringify({ pr: 999, round: 3 }),
    );
    const reset = invoke(bin, stateDir, ["reset", "999"]);
    expect(reset.exitCode).toBe(9);
    expect(existsSync(join(stateDir, "drive-pr-999.json"))).toBe(true);
  });

  it("refuses to reset when `ciHold` parses but is a malformed shape (not null, not a recognized phase object), when GitHub still shows a live transition", () => {
    const root = mkdtempSync(
      join(tmpdir(), "drive-pr-ci-hold-reset-badshape-"),
    );
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr) printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}' ;;
  api)
    case "$*" in
      *timeline*) printf '%s\\n' '[[{"event":"labeled","label":{"name":"ci:hold"},"actor":{"login":"drive-user"},"node_id":"LE_live","created_at":"2026-09-10T10:00:00Z"}]]' ;;
      *) printf '%s\\n' '[]' ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    // `ciHold` is a bare string, not null and not a held-transition object —
    // an unrecognized shape neither `ownsCiHold` nor `hasCiHoldEvidence` can
    // read a phase out of.
    writeFileSync(
      join(stateDir, "drive-pr-999.json"),
      JSON.stringify({ pr: 999, round: 3, ciHold: "stale" }),
    );
    const reset = invoke(bin, stateDir, ["reset", "999"]);
    expect(reset.exitCode).toBe(9);
    expect(existsSync(join(stateDir, "drive-pr-999.json"))).toBe(true);
  });

  it("still allows reset over an EXPLICIT `ciHold: null` without any live check needed", () => {
    // `freshState()`'s own trustworthy "never held" marker — the ordinary,
    // expected case for the vast majority of resets. Uses a `gh` stub that
    // errors on any timeline call, pinning that this path never reaches it.
    const root = mkdtempSync(
      join(tmpdir(), "drive-pr-ci-hold-reset-explicit-null-"),
    );
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    writeGhStub(
      gh,
      `#!/bin/sh\ncase "$*" in\n  *timeline*) echo "should not be called" >&2; exit 1 ;;\n  *) printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}' ;;\nesac\n`,
    );
    writeFileSync(
      join(stateDir, "drive-pr-999.json"),
      JSON.stringify({ pr: 999, round: 3, ciHold: null }),
    );
    const reset = invoke(bin, stateDir, ["reset", "999"]);
    expect(reset.exitCode).toBe(0);
  });

  it("refuses to reset unreadable state truncated BEFORE the ciHold key was ever serialized, when GitHub still shows a live transition", () => {
    // `freshState()` emits `ciHold` after several other fields, so a realistic
    // truncated write can cut off before the key appears at all — the local
    // file then contains zero raw-byte evidence, even though a ci:hold
    // transition is genuinely live on GitHub. Raw-text scanning alone cannot
    // see past that: only checking the actual timeline closes it.
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-reset-live-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr) printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}' ;;
  api)
    case "$*" in
      *timeline*) printf '%s\\n' '[[{"event":"labeled","label":{"name":"ci:hold"},"actor":{"login":"drive-user"},"node_id":"LE_live","created_at":"2026-09-10T10:00:00Z"}]]' ;;
      *) printf '%s\\n' '[]' ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    // Truncated before "ciHold" is ever written — the field is entirely
    // absent from the bytes, not merely malformed.
    writeFileSync(
      join(stateDir, "drive-pr-999.json"),
      '{"pr":999,"round":3,"lastPushedSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    );
    const reset = invoke(bin, stateDir, ["reset", "999"]);
    expect(reset.exitCode).toBe(9);
    expect(existsSync(join(stateDir, "drive-pr-999.json"))).toBe(true);
  });

  it("refuses to reset unreadable state when the live timeline itself cannot be read", () => {
    // Neither the raw bytes nor GitHub confirm there is nothing to preserve
    // — an inconclusive live read is refused for the same reason an
    // inconclusive parse already is, rather than silently treated as "no
    // evidence found".
    const root = mkdtempSync(
      join(tmpdir(), "drive-pr-ci-hold-reset-live-fail-"),
    );
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr) printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}' ;;
  api)
    case "$*" in
      *timeline*) exit 1 ;;
      *) printf '%s\\n' '[]' ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    writeFileSync(
      join(stateDir, "drive-pr-999.json"),
      '{"pr":999,"round":3,"lastPushedSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    );
    const reset = invoke(bin, stateDir, ["reset", "999"]);
    expect(reset.exitCode).toBe(9);
    expect(existsSync(join(stateDir, "drive-pr-999.json"))).toBe(true);
  });
});

describe("ci-hold.ts final-ready", () => {
  function fakeGh(checkRunsJson: string): { bin: string; stateDir: string } {
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-final-ready-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr) printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}' ;;
  api)
    case "$*" in
      *timeline*) printf '%s\\n' '[[]]' ;;
      *) printf '%s\\n' '${checkRunsJson}' ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    return { bin, stateDir };
  }

  function invoke(
    bin: string,
    stateDir: string,
    requireSuccess = false,
  ): ReturnType<typeof Bun.spawnSync> {
    return Bun.spawnSync(
      scriptArgv(
        join(import.meta.dir, "..", "scripts", "ci-hold.ts"),
        "final-ready",
        "999",
        "--expect-head",
        HEAD,
        ...(requireSuccess ? ["--require-success"] : []),
      ),
      {
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          JIG_OVERLAY: HOLD_OVERLAY,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  }

  const runsWith = (
    testsConclusion: string,
    schemaGateConclusion: string,
  ): string =>
    JSON.stringify([
      {
        check_runs: [
          {
            id: 1,
            name: "code-quality-and-build",
            head_sha: HEAD,
            status: "completed",
            conclusion: "success",
            created_at: "2026-09-10T10:01:00Z",
            started_at: "2026-09-10T10:01:00Z",
          },
          {
            id: 2,
            name: "tests",
            head_sha: HEAD,
            status: "completed",
            conclusion: testsConclusion,
            created_at: "2026-09-10T10:01:00Z",
            started_at: "2026-09-10T10:01:00Z",
          },
          {
            id: 3,
            name: "Schema gate",
            head_sha: HEAD,
            status: "completed",
            conclusion: schemaGateConclusion,
            created_at: "2026-09-10T10:01:00Z",
            started_at: "2026-09-10T10:01:00Z",
          },
        ],
      },
    ]);

  it("reports ready over a genuinely green, unheld head", () => {
    const { bin, stateDir } = fakeGh(runsWith("success", "success"));
    expect(invoke(bin, stateDir).exitCode).toBe(0);
    expect(invoke(bin, stateDir, true).exitCode).toBe(0);
  });

  it("DEFAULT (no --require-success) still reports ready over a completed-but-failed head — drive.ts depends on this", () => {
    // drive.ts treats exit 4 as "not fresh yet, keep polling" and separately
    // re-derives the real green/red verdict from drive-status.ts's own `.ci`
    // field once this returns 0 (scripts/drive.ts, the `finalCi.code === 4`
    // branch). Requiring success by DEFAULT here made a genuinely failed
    // required check indistinguishable from a still-catching-up one, so the
    // driver retried forever instead of ever reaching its own red-CI
    // detection — measured directly: `drive.ts loop control > stops for
    // /fix-ci when the … witness completed red` timed out at 30s. See
    // finalReady's own doc comment in ci-hold.ts.
    const { bin, stateDir } = fakeGh(runsWith("failure", "success"));
    expect(invoke(bin, stateDir).exitCode).toBe(0);
  });

  it("--require-success refuses when a required check completed with a non-success conclusion", () => {
    // A required check rerun after the single aggregate-status snapshot
    // announce-merge-ready.ts takes at the top of its run can finish
    // `failure` before a LATER confirmFinalCi() call — completedRequiredCi's
    // default `requireSuccess` (false) merely checks the run is completed
    // and non-skipped, which a failed run also satisfies. `--require-success`
    // is the dedicated opt-in this caller passes to close that race
    // — see announce-merge-ready.ts's own
    // finalCiProof() for why it, and not drive.ts, needs this.
    const { bin, stateDir } = fakeGh(runsWith("failure", "success"));
    expect(invoke(bin, stateDir, true).exitCode).toBe(4);
  });

  it("--require-success refuses when the Schema gate witness itself completed with a non-success conclusion", () => {
    // Same bug, second instance: a required check that completed with a
    // non-success conclusion is "completed, non-skipped", so it satisfies the
    // freshness proof. set-verified (drive-state.ts) requires success for
    // the identical proof; `--require-success` makes finalReady match it.
    const { bin, stateDir } = fakeGh(runsWith("success", "failure"));
    expect(invoke(bin, stateDir, true).exitCode).toBe(4);
  });

  it("--require-success refuses when a legacy commit STATUS is failing, even with every check-run green", () => {
    // finalReady's witness/completedRequiredCi checks only ever read
    // check-runs — a legacy status context turning failing after
    // announce-merge-ready.ts's initial snapshot was invisible to every
    // later --require-success confirmation, which could then preserve a
    // "Safe to merge" comment over a red aggregate verdict. Distinguishes
    // the `/status?` endpoint from check-runs, unlike the shared `fakeGh`
    // above (whose fallback branch answers both alike, which is why every
    // OTHER test in this block is unaffected by this fix — a fallback JSON
    // shape with no `statuses` key parses to `[]`, i.e. clean).
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-status-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr) printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}' ;;
  api)
    case "$*" in
      *timeline*) printf '%s\\n' '[[]]' ;;
      *'/status?'*) printf '%s\\n' '[{"statuses":[{"context":"legacy-ci","state":"failure","description":null}]}]' ;;
      *) printf '%s\\n' '${runsWith("success", "success")}' ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    // The DEFAULT path never reads commit statuses at all — only
    // --require-success does.
    expect(invoke(bin, stateDir, false).exitCode).toBe(0);
    expect(invoke(bin, stateDir, true).exitCode).toBe(4);
  });

  it("--require-success refuses when a commit status turns failing between the initial aggregate check and stillCurrentForFinalReady's re-snapshot", () => {
    // requiredCiAggregateIsGreen() runs once for the initial proof, then
    // stillCurrentForFinalReady() re-snapshots PR state/head/held/timeline
    // right before commit — but that re-snapshot used to check nothing
    // about CI freshness at all, so a status flipping between the two calls
    // was invisible. The status endpoint answers GREEN on its first call
    // (the initial proof) and FAILING on its second (the freshness
    // re-check), modeling exactly that window.
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-status-race-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    const counter = join(root, "status-calls");
    writeFileSync(counter, "0");
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr) printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}' ;;
  api)
    case "$*" in
      *timeline*) printf '%s\\n' '[[]]' ;;
      *'/status?'*)
        n=$(cat ${counter})
        echo $((n + 1)) > ${counter}
        if [ "$n" -eq 0 ]; then
          printf '%s\\n' '[{"statuses":[]}]'
        else
          printf '%s\\n' '[{"statuses":[{"context":"legacy-ci","state":"failure","description":null}]}]'
        fi
        ;;
      *) printf '%s\\n' '${runsWith("success", "success")}' ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    expect(invoke(bin, stateDir, true).exitCode).toBe(4);
  });

  it("--require-success refuses when a required check is superseded by a NEWER skipped run only at the re-check", () => {
    // An earlier version added the aggregate ciVerdictOf check but the
    // re-verification only ever re-ran IT, never completedRequiredCi/the
    // witness — and ciVerdictOf's own PASSING_CONCLUSIONS treats `skipped` as
    // passing, unlike completedRequiredCi. So a required check superseded by a
    // fresher SKIPPED run between the initial proof and the re-check was
    // invisible to the re-check even though it would have failed the INITIAL
    // proof outright. finalCiProofGreen is now the one shared predicate for
    // both, so the re-check catches this identically.
    //
    // The check-runs endpoint answers with a clean, all-success set for its
    // first two hits (the initial finalCiProofGreen call: its own
    // checkRuns() plus the aggregate's checkRunsFor()), then a set where
    // `tests` has been superseded by a newer SKIPPED run for every hit
    // after that (the re-check's own finalCiProofGreen call).
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-skip-race-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    const counter = join(root, "check-runs-calls");
    writeFileSync(counter, "0");
    const goodRuns = runsWith("success", "success");
    const supersededRuns = JSON.stringify([
      {
        check_runs: [
          {
            id: 1,
            name: "code-quality-and-build",
            head_sha: HEAD,
            status: "completed",
            conclusion: "success",
            created_at: "2026-09-10T10:01:00Z",
            started_at: "2026-09-10T10:01:00Z",
          },
          {
            id: 2,
            name: "tests",
            head_sha: HEAD,
            status: "completed",
            conclusion: "success",
            created_at: "2026-09-10T10:01:00Z",
            started_at: "2026-09-10T10:01:00Z",
          },
          {
            id: 4,
            name: "tests",
            head_sha: HEAD,
            status: "completed",
            conclusion: "skipped",
            created_at: "2026-09-10T10:02:00Z",
            started_at: "2026-09-10T10:02:00Z",
          },
          {
            id: 3,
            name: "Schema gate",
            head_sha: HEAD,
            status: "completed",
            conclusion: "success",
            created_at: "2026-09-10T10:01:00Z",
            started_at: "2026-09-10T10:01:00Z",
          },
        ],
      },
    ]);
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr) printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}' ;;
  api)
    case "$*" in
      *timeline*) printf '%s\\n' '[[]]' ;;
      *'/status?'*) printf '%s\\n' '[{"statuses":[]}]' ;;
      *)
        n=$(cat ${counter})
        echo $((n + 1)) > ${counter}
        if [ "$n" -lt 2 ]; then
          printf '%s\\n' '${goodRuns}'
        else
          printf '%s\\n' '${supersededRuns}'
        fi
        ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    expect(invoke(bin, stateDir, true).exitCode).toBe(4);
  });

  it("catches a head change landing in the window stillCurrentForFinalReady's OWN timeline call spends on the network", () => {
    // An earlier version reordered the CI proof to run before the PR/timeline
    // snapshot, but left snapshot() (the head check) running BEFORE
    // transitions() WITHIN that snapshot step — so a push landing while
    // transitions()'s own network round-trip was in flight was still invisible:
    // the head check had already passed on stale evidence by the time it
    // happened.
    //
    // Modeled with a shared counter keyed on the SECOND timeline call, not
    // total call count (fragile to unrelated call-count drift elsewhere in
    // the flow): the `pr view` stub answers the ORIGINAL head until the
    // timeline endpoint has been hit twice (finalReady's own initial read,
    // then stillCurrentForFinalReady's), and the RACED head from then on.
    // Under the CURRENT (fixed) order — transitions() before snapshot() —
    // stillCurrentForFinalReady's OWN snapshot() call happens AFTER its own
    // transitions() call, so by the time it fires the timeline has already
    // been hit twice and it correctly observes the race. Under the OLD
    // order this test pins against via mutation, snapshot() would run
    // BEFORE that second timeline hit and would still see the stale,
    // original head.
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-order-race-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    const RACED_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const timelineCalls = join(root, "timeline-calls");
    writeFileSync(timelineCalls, "0");
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr)
    n=$(cat ${timelineCalls})
    if [ "$n" -ge 2 ]; then
      printf '%s\\n' '{"state":"OPEN","headRefOid":"${RACED_HEAD}","labels":[]}'
    else
      printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}'
    fi
    ;;
  api)
    case "$*" in
      *timeline*)
        n=$(cat ${timelineCalls})
        echo $((n + 1)) > ${timelineCalls}
        printf '%s\\n' '[[]]'
        ;;
      *'/status?'*) printf '%s\\n' '[{"statuses":[]}]' ;;
      *) printf '%s\\n' '${runsWith("success", "success")}' ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    expect(invoke(bin, stateDir, true).exitCode).toBe(4);
  });

  function fakeGhRacingHead(
    checkRunsJson: string,
    secondHead: string,
  ): { bin: string; stateDir: string } {
    // `pr view` answers HEAD on its first call (the entry snapshot) and
    // secondHead on every later call (the final re-check) — modeling a push
    // that lands in the window finalReady spends reading check-runs and the
    // label timeline.
    const root = mkdtempSync(join(tmpdir(), "drive-pr-ci-hold-race-"));
    const bin = join(root, "bin");
    const stateDir = join(root, "state");
    Bun.spawnSync(["mkdir", "-p", bin, stateDir]);
    const gh = join(bin, "gh");
    const counter = join(root, "pr-view-calls");
    writeFileSync(counter, "0");
    writeGhStub(
      gh,
      `#!/bin/sh
case "$1" in
  pr)
    n=$(cat ${counter})
    echo $((n + 1)) > ${counter}
    if [ "$n" -eq 0 ]; then
      printf '%s\\n' '{"state":"OPEN","headRefOid":"${HEAD}","labels":[]}'
    else
      printf '%s\\n' '{"state":"OPEN","headRefOid":"${secondHead}","labels":[]}'
    fi
    ;;
  api)
    case "$*" in
      *timeline*) printf '%s\\n' '[[]]' ;;
      *) printf '%s\\n' '${checkRunsJson}' ;;
    esac ;;
  *) exit 1 ;;
esac
`,
    );
    return { bin, stateDir };
  }

  it("refuses when the head moves between the entry snapshot and the final re-check", () => {
    const otherHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { bin, stateDir } = fakeGhRacingHead(
      runsWith("success", "success"),
      otherHead,
    );
    expect(invoke(bin, stateDir).exitCode).toBe(4);
  });
});
