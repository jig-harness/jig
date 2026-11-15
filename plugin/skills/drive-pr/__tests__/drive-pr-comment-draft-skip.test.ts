/** CodeRabbit's comment-only draft skip, through the forge and drive. */
import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  type Fixture,
  binDir,
  HEAD,
  probeIn,
  scratchClean,
  SCRIPTS,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { PASS_LOUD, runDriveIn } from "./drive-loop-harness.ts";

useDrivePrSuite();
const env = { DRIVE_PR_REVIEWER_APP: "coderabbitai" };
const marker =
  "<!-- This is an auto-generated comment: skip review by coderabbit.ai -->";
const heading =
  "## Draft PR not reviewed\nTo automatically review draft PRs, update your CodeRabbit configuration.";
const draftSkip = `${marker}\n${heading}`;

function fixture(body: unknown, f: Fixture = {}, login = "coderabbitai[bot]") {
  const result = writeFixture(
    { threads: [], reviewedSha: null, checkRuns: [], isDraft: true, ...f },
    scratchClean.dir,
  );
  writeFileSync(
    join(result.dir, "issue-comments.json"),
    JSON.stringify([
      { id: 1, body, user: { login }, author_association: "NONE" },
    ]),
  );
  return result;
}

async function gate(body: unknown, f: Fixture = {}, login?: string) {
  const { dir, stateDir } = fixture(body, f, login);
  return probeIn(dir, stateDir, f.head ?? HEAD, [], { env });
}

function expectProbeExit(r: Awaited<ReturnType<typeof probeIn>>, code: number) {
  expectSpawnExit({ ...r, stdout: JSON.stringify(r.json) }, code);
}

describe("a comment-only draft skip", () => {
  for (const body of [draftSkip, heading, "**Draft PR not reviewed**"]) {
    it("converges only when the configured reviewer supplies the draft notice", async () => {
      const r = await gate(body);
      expectProbeExit(r, 3);
      expect(r.state).toBe("CONVERGED");
      expect(
        (r.json.reviewer as Record<string, unknown>).reviewedShaSource,
      ).toBe("draft-skip");
    });
  }

  it("works existing findings before marking the draft Ready", async () => {
    const r = await gate(draftSkip, {
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    expectProbeExit(r, 0);
    expect(r.state).toBe("ROUND_READY");
  });

  it("keeps waiting on a Ready pull request with the old comment", async () => {
    const r = await gate(marker, { isDraft: false });
    expectProbeExit(r, 4);
    expect(r.state).toBe("AWAITING_REVIEWER");
  });

  it("reads the current body after the skip is edited into a summary", async () => {
    const { dir, stateDir } = fixture(draftSkip);
    const before = await probeIn(dir, stateDir, HEAD, [], { env });
    expectProbeExit(before, 3);
    writeFileSync(
      join(dir, "issue-comments.json"),
      JSON.stringify([
        {
          id: 1,
          body: "<!-- walkthrough_start -->\nReview summary",
          user: { login: "coderabbitai[bot]" },
        },
      ]),
    );
    const after = await probeIn(dir, stateDir, HEAD, [], { env });
    expectProbeExit(after, 4);
    expect(after.state).toBe("AWAITING_REVIEWER");
  });

  const untrusted: [string, string, string?][] = [
    ["a marker with no notice", marker],
    ["another author's notice", draftSkip, "someone"],
    ["prose naming the notice", "The description says Draft PR not reviewed"],
    ["an unrelated heading", "## Review summary"],
    [
      "a fenced example",
      "Old notice:\n```markdown\n## Draft PR not reviewed\n```",
    ],
    ["a tilde fence", "~~~\n## Draft PR not reviewed\n~~~"],
    [
      "a multiline code span",
      "The old notice is `\n**Draft PR not reviewed**\n`.",
    ],
    ["indented code", "    ## Draft PR not reviewed"],
    ["a quote", "> ## Draft PR not reviewed"],
    [
      "a fence closed by a non-fence",
      "```markdown\n```typescript\n## Draft PR not reviewed\n```",
    ],
    [
      "a tilde fence closed by a non-fence",
      "~~~\n~~~ts\n## Draft PR not reviewed\n~~~",
    ],
    ["an HTML comment", "<!--\n## Draft PR not reviewed\n-->"],
    ["a pre block", "<pre>\n## Draft PR not reviewed\n</pre>"],
    [
      "a heading after an HTML block opener",
      "<!-- example -->## Draft PR not reviewed",
    ],
    [
      "a heading after a comment that hides a fence",
      "```html\n<!--\n```\n## Draft PR not reviewed\n-->",
    ],
    ["a textarea block", "<textarea>\n## Draft PR not reviewed\n</textarea>"],
    ["a script block", "<script>\n## Draft PR not reviewed\n</script>"],
    ["a div block", "<div>\n## Draft PR not reviewed\n</div>"],
  ];
  for (const [name, body, login] of untrusted) {
    it(`does not trust ${name}`, async () => {
      const result = await gate(body, {}, login);
      expectProbeExit(result, 4);
      expect(result.state).toBe("AWAITING_REVIEWER");
    });
  }

  it("does not use CodeRabbit's comment for another configured reviewer", async () => {
    const { dir, stateDir } = fixture(draftSkip);
    const r = await probeIn(dir, stateDir, HEAD, [], {
      env: {
        DRIVE_PR_REVIEWER_APP: "other-reviewer",
        DRIVE_PR_REVIEWER_EVIDENCE: "review_object",
      },
    });
    expectProbeExit(r, 4);
    expect(r.state).toBe("AWAITING_REVIEWER");
  });

  it("uses the same current comment evidence in the standalone review loop", async () => {
    for (const isDraft of [true, false]) {
      const { dir, stateDir } = fixture(draftSkip, { isDraft });
      const child = Bun.spawn(
        [process.execPath, join(SCRIPTS, "review-head.ts"), "999", HEAD],
        {
          env: {
            ...process.env,
            ...env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(isDraft ? 0 : 4);
      expectSpawnExit({ stdout, stderr, exitCode }, isDraft ? 0 : 4);
    }
  });

  it("does not bypass a newer running check or failed check", async () => {
    for (const status of ["in_progress", "completed"]) {
      const r = await gate(draftSkip, {
        checkRuns: [
          {
            name: "CodeRabbit",
            app: "coderabbitai",
            status,
            conclusion: status === "completed" ? "failure" : null,
          },
        ],
      });
      expect(r.state).toBe(
        status === "completed" ? "REVIEWER_FAILED" : "AWAITING_REVIEWER",
      );
    }
  });

  it("fails closed on an unreadable configured reviewer's comment body", async () => {
    const r = await gate(7);
    expectProbeExit(r, 1);
    expect(r.state).toBe("INDETERMINATE");
  });

  it("marks the draft Ready before waiting for its first review", async () => {
    const { dir, stateDir } = fixture(draftSkip, { head: scratchClean.head });
    const r = await runDriveIn(
      dir,
      stateDir,
      [
        "--no-head-sync",
        "--timeout",
        "5",
        "--interval",
        "5",
        "--",
        ...PASS_LOUD,
      ],
      undefined,
      { env },
    );
    expect(readFileSync(join(dir, "ready-calls"), "utf8").trim()).toBe("999");
    expectSpawnExit({ ...r, stdout: "" }, 4);
  }, 120_000);
});
