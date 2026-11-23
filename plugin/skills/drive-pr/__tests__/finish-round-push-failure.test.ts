/**
 * drive-pr suite: why a failed push failed, as `finish-round.ts` records it
 * for the stall stop (`lib/push-failure.ts`, `lib/state/round-finish.ts`).
 */
import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  failureExcerpt,
  pushFailureKind,
  pushFailureReason,
} from "../scripts/lib/push-failure.ts";
import { readRoundFinishes } from "../scripts/lib/state/round-finish.ts";
import { createFindingsFinishRoundFixtures } from "./drive-pr-findings-finish-round-fixtures.ts";
import { useDrivePrSuite } from "./drive-pr-harness.ts";

useDrivePrSuite();

const HOOK_FAILURE = [
  "lefthook v1.11.0  hook: pre-push",
  "\u001b[31m┃  typecheck ❯\u001b[0m",
  "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "\u001b[31m  typecheck failed\u001b[0m",
  "error: failed to push some refs to 'https://github.com/example/repo.git'",
  "guarded-push: push to PR #999's head branch (feature) failed",
].join("\n");

describe("a failed push's reason", () => {
  it("tells a pre-push gate from a remote rejection, a dead connection, a timeout and an unconfirmed head", () => {
    expect(pushFailureKind(HOOK_FAILURE)).toBe("pre-push-gate");
    expect(
      pushFailureKind(
        " ! [remote rejected] HEAD -> feature (protected branch hook declined)\nerror: failed to push some refs to 'origin'",
      ),
    ).toBe("remote-rejected");
    expect(
      pushFailureKind(
        "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
      ),
    ).toBe("transport");
    expect(
      pushFailureKind(
        "guarded-push: push to PR #9's head branch (b) exceeded\n3600s and was killed.",
      ),
    ).toBe("timeout");
    expect(
      pushFailureKind(
        "guarded-push: pushed abc to b, but PR #9 still reports def.",
      ),
    ).toBe("unconfirmed");
    expect(pushFailureKind("")).toBe("unknown");
  });

  it("quotes the output's last lines, uncoloured and bounded, never guarded-push's own generic line", () => {
    const excerpt = failureExcerpt(HOOK_FAILURE);
    expect(excerpt).toContain("typecheck failed");
    expect(excerpt).toContain("error TS2322");
    expect(excerpt).not.toContain("\u001b");
    expect(excerpt).not.toContain("guarded-push: push to PR");
    const long = Array.from(
      { length: 40 },
      (_, i) => `${i} ${"x".repeat(500)}`,
    ).join("\n");
    expect(failureExcerpt(long).length).toBeLessThanOrEqual(600);
    expect(
      failureExcerpt("token ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    ).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("names the exit, the kind and what it means", () => {
    expect(pushFailureReason(1, HOOK_FAILURE)).toStartWith(
      "guarded-push.ts exited 1 (pre-push-gate): the pre-push hook's gates refused the push — ",
    );
    expect(pushFailureReason(1, "")).toBe(
      "guarded-push.ts exited 1 (unknown): the push failed; it wrote nothing on stderr",
    );
  });
});

describe("finish-round.ts on a failed push", () => {
  const { finishRound } = createFindingsFinishRoundFixtures();

  it("records why the push failed in the round's finish, and still shows the push's own output", async () => {
    const r = await finishRound({
      seedState: async ({ fixtureDir }) => {
        writeFileSync(join(fixtureDir, "push-fails"), `${HOOK_FAILURE}\n`);
      },
      // A drive's pass: the round's finish is recorded for the stall stop.
      env: { DRIVE_PR_TARGET: "999", DRIVE_PR_ROUND: "2" },
    });
    expectSpawnExit(r, 1);
    expect(r.report.state).toBe("PUSH_FAILED");
    expect(r.report.reason).not.toContain("see its diagnostic above");
    expect(r.report.reason).toContain("(pre-push-gate)");
    expect(r.report.reason).toContain("typecheck failed");
    expect(r.stderr).toContain("error TS2322");
    const [finish] = readRoundFinishes(r.stateDir, "999");
    expect(finish).toMatchObject({
      round: 2,
      state: "PUSH_FAILED",
      reason: r.report.reason,
    });
  });

  it("names a remote's rejection as one", async () => {
    const r = await finishRound({
      seedState: async ({ fixtureDir }) => {
        writeFileSync(join(fixtureDir, "push-fails"), "");
      },
    });
    expectSpawnExit(r, 1);
    expect(r.report.state).toBe("PUSH_FAILED");
    expect(r.report.reason).toContain("(remote-rejected)");
    expect(r.report.reason).toContain("[remote rejected]");
  });
});
