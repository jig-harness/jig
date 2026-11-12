/**
 * drive-pr suite: drive-status.ts over a reviewer that records its reviews as
 * pull-request review objects (`review.reviewer_evidence: review_object`),
 * through CodeRabbit's built-in profile: `review.reviewer_app: coderabbitai`
 * alone. The check-run titles are CodeRabbit's measured ones. Shared fixtures
 * live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { fingerprintOf } from "../scripts/lib/finding-fingerprint.ts";
import { parseCodeRabbitBody } from "../scripts/lib/review-body.ts";
import {
  binDir,
  type CheckRunFixture,
  type Fixture,
  HEAD,
  PREV,
  probe,
  SCRIPTS,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";

useDrivePrSuite();

const CODERABBIT = { DRIVE_PR_REVIEWER_APP: "coderabbitai" };
const LOGIN = "coderabbitai[bot]";

function rabbit(over: Partial<CheckRunFixture> = {}): CheckRunFixture {
  return {
    name: "CodeRabbit",
    app: "coderabbitai",
    status: "completed",
    conclusion: "success",
    title: "Review completed",
    started: "2026-11-11T09:00:00Z",
    completed_at: "2026-11-11T09:05:00Z",
    ...over,
  };
}

function review(
  commit: string,
  id = 1,
  at = "2026-11-11T09:04:00Z",
  body = "",
) {
  return {
    id,
    user: { login: LOGIN },
    state: "COMMENTED",
    commit_id: commit,
    submitted_at: at,
    body,
  };
}

/** A CodeRabbit review body (`fixtures/coderabbit/`) and its findings' keys. */
function rabbitBody(name: string) {
  const body = readFileSync(
    join(import.meta.dir, "fixtures", "coderabbit", `${name}.md`),
    "utf8",
  );
  const keys = parseCodeRabbitBody(body).entries.map((e) =>
    fingerprintOf(e.path, e.lines, e.text),
  );
  return { body, keys };
}

async function gate(f: Fixture, env: Record<string, string> = CODERABBIT) {
  const r = await probe({ threads: [], reviewedSha: null, ...f }, [], { env });
  const reviewer = r.json.reviewer as Record<string, unknown>;
  const work = r.json.work as Record<string, unknown>;
  const stdout = JSON.stringify(r.json);
  return { ...r, stdout, reason: String(r.json.reason ?? ""), reviewer, work };
}

describe("a review-object reviewer (CodeRabbit's profile)", () => {
  it("converges on a review object naming the head, with no sticky stamp", async () => {
    const r = await gate({
      checkRuns: [rabbit()],
      reviews: [review(PREV, 1), review(HEAD, 2)],
    });
    expect(r.state).toBe("CONVERGED");
    expectSpawnExit(r, 3);
    expect(r.reviewer.reviewedShaSource).toBe("review-object");
    expect(r.reviewer.reviewedSha).toBe(HEAD);
  });

  it("converges on its completed run on the head when it posted no newer review", async () => {
    const r = await gate({
      checkRuns: [rabbit()],
      reviews: [review(PREV, 1, "2026-11-11T08:00:00Z")],
    });
    expect(r.state).toBe("CONVERGED");
    expect(r.reviewer.reviewedShaSource).toBe("review-check-run");
    expect(r.reason).toContain("nothing new to say");
  });

  it("does not converge on a run whose head another review postdates", async () => {
    const r = await gate({
      checkRuns: [rabbit()],
      reviews: [review(PREV, 3, "2026-11-11T09:30:00Z")],
    });
    expect(r.state).toBe("STALE_REVIEW");
    expectSpawnExit(r, 4);
  });

  it("does not converge on a run when the order of a review and the run is unreadable", async () => {
    const r = await gate({
      checkRuns: [rabbit()],
      reviews: [review(PREV, 3, "")],
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.reason).toContain("order of the two is unknown");
  });

  it("waits for a run that has not completed, and for an absent one", async () => {
    const running = await gate({
      checkRuns: [rabbit({ status: "in_progress", conclusion: null })],
      reviews: [review(HEAD)],
    });
    expect(running.state).toBe("AWAITING_REVIEWER");
    const absent = await gate({ checkRuns: [], reviews: [review(HEAD)] });
    expect(absent.state).toBe("AWAITING_REVIEWER");
    expect(absent.reason).toContain("'coderabbitai'");
  });

  it("stops when it paused, naming the pause and quoting its title", async () => {
    const title = "Review paused: new commits are not reviewed";
    const r = await gate({
      checkRuns: [rabbit({ conclusion: "neutral", title })],
      reviews: [review(PREV)],
    });
    expect(r.state).toBe("REVIEW_SKIPPED");
    expectSpawnExit(r, 22);
    expect(r.reason).toContain("paused");
    expect(r.reason).toContain(`"${title}"`);
  });

  it("stops when it skipped the head, naming the skip and quoting its title", async () => {
    const title =
      "Review skipped: manual review required for this OSS repository";
    const r = await gate({
      checkRuns: [rabbit({ conclusion: "skipped", title })],
    });
    expect(r.state).toBe("REVIEW_SKIPPED");
    expectSpawnExit(r, 22);
    expect(r.reason).toContain("skipped this head");
    expect(r.reason).toContain(`"${title}"`);
  });

  it("does not stop on a draft it skipped: the draft converges on its own work", async () => {
    const skip = rabbit({
      conclusion: "skipped",
      title: "Review skipped: draft pull request",
    });
    const clean = await gate({ isDraft: true, checkRuns: [skip] });
    expect(clean.state).toBe("CONVERGED");
    expect(clean.reviewer.reviewedShaSource).toBe("draft-skip");
    expect(clean.reason).toContain("Ready for review");
    const work = await gate({
      isDraft: true,
      checkRuns: [skip],
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    expect(work.state).toBe("ROUND_READY");
  });

  it("waits on a Ready pull request whose newest run is still the draft skip", async () => {
    const r = await gate({
      isDraft: false,
      checkRuns: [
        rabbit({
          conclusion: "skipped",
          title: "Review skipped: draft pull request",
        }),
      ],
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.reason).toContain("draft skip");
  });

  it("is INDETERMINATE when its reviews cannot be read", async () => {
    const r = await gate({
      checkRuns: [rabbit()],
      reviews: [{ ...review(HEAD), commit_id: "not-a-sha" }],
    });
    expect(r.state).toBe("INDETERMINATE");
    const bodiless = await gate({
      checkRuns: [rabbit()],
      reviews: [{ ...review(HEAD), body: 7 as unknown as string }],
    });
    expect(bodiless.state).toBe("INDETERMINATE");
  });

  it("an explicit sticky evidence keeps the comment protocol", async () => {
    const r = await gate(
      { checkRuns: [rabbit()], reviews: [review(HEAD)] },
      { ...CODERABBIT, DRIVE_PR_REVIEWER_EVIDENCE: "sticky" },
    );
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.reviewer.reviewedShaSource).toBe("check-run");
  });
});

describe("a review-object reviewer's findings in its review body", () => {
  it("does not converge over an outside-diff finding until it is answered", async () => {
    const { body, keys } = rabbitBody("pipe-fields-outside-diff");
    const reviews = [review(HEAD, 2, undefined, body)];
    const open = await gate({ checkRuns: [rabbit()], reviews });
    expect(open.state).toBe("ROUND_READY");
    expect(open.work.summaryUnaddressed).toBe(1);
    const answered = await gate({
      checkRuns: [rabbit()],
      reviews,
      addressed: keys,
    });
    expect(answered.state).toBe("CONVERGED");
    expect(answered.work.summaryFindings).toBe(1);
  });

  it("reads the findings of every review it submitted", async () => {
    const earlier = rabbitBody("grouped-sections");
    const actionable = rabbitBody("current-actionable");
    const outside = rabbitBody("current-outside-diff");
    const r = await gate({
      checkRuns: [rabbit()],
      reviews: [
        review(PREV, 1, undefined, earlier.body),
        review(HEAD, 2, undefined, actionable.body),
        review(HEAD, 3, undefined, outside.body),
      ],
      addressed: [...earlier.keys, ...actionable.keys],
    });
    expect(r.state).toBe("ROUND_READY");
    expect(r.work.summaryFindings).toBe(6);
    expect(r.work.summaryUnaddressed).toBe(1);
  });

  it("keeps an earlier review's findings open when its run on the head added no review", async () => {
    const r = await gate({
      checkRuns: [rabbit()],
      reviews: [
        review(PREV, 1, "2026-11-11T08:00:00Z", rabbitBody("duplicate").body),
      ],
    });
    expect(r.reviewer.reviewedShaSource).toBe("review-check-run");
    expect(r.state).toBe("ROUND_READY");
    expect(r.work.summaryUnaddressed).toBe(2);
  });
});

describe("review-head.ts over a review-object reviewer", () => {
  async function head(f: Fixture) {
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: null,
      ...f,
    });
    const proc = Bun.spawn(
      [process.execPath, join(SCRIPTS, "review-head.ts"), "999", HEAD],
      {
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          ...CODERABBIT,
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
    return { exitCode, stdout, stderr };
  }

  it("answers witnessed, waiting, and a review that will not come", async () => {
    expectSpawnExit(
      await head({ checkRuns: [rabbit()], reviews: [review(HEAD)] }),
      0,
    );
    expectSpawnExit(
      await head({
        checkRuns: [rabbit({ status: "in_progress", conclusion: null })],
      }),
      4,
    );
    const paused = await head({
      checkRuns: [rabbit({ title: "Review paused" })],
    });
    expectSpawnExit(paused, 1);
    expect(paused.stderr).toContain("paused");
    const draft = await head({
      isDraft: true,
      checkRuns: [
        rabbit({
          conclusion: "skipped",
          title: "Review skipped: draft pull request",
        }),
      ],
    });
    expectSpawnExit(draft, 0);
  });
});
