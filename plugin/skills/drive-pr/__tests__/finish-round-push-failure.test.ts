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
  observedPush,
  outputTail,
  pushFailureKind,
  pushFailureReason,
} from "../scripts/lib/push-failure.ts";
import { readRoundFinishes } from "../scripts/lib/state/round-finish.ts";
import { createFindingsFinishRoundFixtures } from "./drive-pr-findings-finish-round-fixtures.ts";
import { tmpRoot, useDrivePrSuite } from "./drive-pr-harness.ts";

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
    expect(
      pushFailureKind(
        "guarded-push: pushed abc to origin, but PR #9 still reports def.",
      ),
    ).toBe("unconfirmed");
    // A gate whose own output reads like git's transport errors is still a gate.
    expect(
      pushFailureKind(
        [
          "fatal: not a git repository (or any of the parent directories): .git",
          "  ✗ test: connection refused by the fixture server",
          "error: failed to push some refs to 'origin'",
        ].join("\n"),
      ),
    ).toBe("pre-push-gate");
  });

  it("quotes why a push that never started could not start", async () => {
    const { res, failure } = await observedPush([
      join(tmpRoot, "no-such-program-here"),
    ]);
    expect(res.code).not.toBe(0);
    expect(failure()).toContain("(unknown)");
    expect(failure()).not.toContain("it wrote nothing on stderr");
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

  it("masks a credential whose key would otherwise be cut before the retained tail", () => {
    const tail = outputTail();
    tail.observe(
      Buffer.from(`password=${"s".repeat(20 * 1024)}\npre-push failed`),
    );
    expect(tail.text()).not.toContain("s".repeat(100));
    expect(tail.text()).toContain("password=<redacted>");
    expect(tail.text()).toContain("pre-push failed");
  });

  it("masks a credential and keeps a character that arrive split between chunks", () => {
    const tail = outputTail();
    tail.observe(Buffer.from("error: token ghp_abcdefgh"));
    tail.observe(Buffer.from("ijklmnopqrstuvwxyz0123456789 rejected\n"));
    const bytes = Buffer.from("fehler: größe\n");
    tail.observe(bytes.subarray(0, 10));
    tail.observe(bytes.subarray(10));
    expect(tail.text()).not.toContain("ijklmnop");
    expect(tail.text()).toContain("<redacted>");
    expect(tail.text()).toContain("größe");
    expect(tail.text()).not.toContain("�");
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

describe("the push output's tail", () => {
  it("never publishes the continuation of an over-long line whose key was flushed", () => {
    const tail = outputTail();
    const enc = new TextEncoder();
    tail.observe(enc.encode("password="));
    tail.observe(enc.encode("s".repeat(300 * 1024)));
    tail.observe(enc.encode("TOPSECRETVALUE"));
    tail.observe(enc.encode("\nnext line\n"));
    const out = tail.text();
    expect(out).not.toContain("TOPSECRETVALUE");
    expect(out).toContain("next line");
  });

  it("drops everything after an unclosed quoted value that never closes", () => {
    const tail = outputTail();
    const enc = new TextEncoder();
    tail.observe(enc.encode('password="first '));
    tail.observe(enc.encode("s".repeat(300 * 1024)));
    tail.observe(enc.encode("LATERSECRET\nnext line\n"));
    const out = tail.text();
    expect(out).not.toContain("LATERSECRET");
    expect(out).not.toContain("first");
    expect(out).toContain("[over-long output omitted]");
  });

  it("keeps recent complete lines when short-line output passes the bound", () => {
    const tail = outputTail();
    const enc = new TextEncoder();
    tail.observe(enc.encode("filler line\n".repeat(30 * 1024)));
    tail.observe(enc.encode("error: failed to push some refs\n"));
    const out = tail.text();
    expect(out).toContain("[over-long output omitted]");
    expect(out).toContain("error: failed to push some refs");
  });

  it("drops the kept lines through the close of a quote the dropped part left open", () => {
    const tail = outputTail();
    const enc = new TextEncoder();
    tail.observe(enc.encode('password="first\n'));
    tail.observe(enc.encode("filler line\n".repeat(30 * 1024)));
    tail.observe(enc.encode('LATERSECRET"\nnext line\n'));
    const out = tail.text();
    expect(out).not.toContain("LATERSECRET");
    expect(out).toContain("next line");
  });

  it("masks the continuation of a quoted value that spans lines", () => {
    const tail = outputTail();
    tail.observe(Buffer.from('password="first\n'));
    tail.observe(Buffer.from('SECONDSECRET"\nnext line\n'));
    const out = tail.text();
    expect(out).not.toContain("SECONDSECRET");
    expect(out).toContain("next line");
  });

  it("does not read an escaped quote in the dropped part as a closing quote", () => {
    const tail = outputTail();
    const enc = new TextEncoder();
    tail.observe(enc.encode('password="first \\"\n'));
    tail.observe(enc.encode("filler line\n".repeat(30 * 1024)));
    tail.observe(enc.encode('LATERSECRET"\nnext line\n'));
    const out = tail.text();
    expect(out).not.toContain("LATERSECRET");
    expect(out).toContain("next line");
  });

  it("omits a quoted value still open at the end, with its key", () => {
    const tail = outputTail();
    tail.observe(Buffer.from("error: failed to push some refs\n"));
    tail.observe(Buffer.from('password="first\nSECONDSECRET'));
    const out = tail.text();
    expect(out).not.toContain("SECONDSECRET");
    expect(out).not.toContain("first");
    expect(out).toContain("failed to push some refs");
  });

  it("keeps a line with an apostrophe in prose", () => {
    const tail = outputTail();
    tail.observe(
      Buffer.from("hook: can't connect\nerror: failed to push some refs\n"),
    );
    expect(tail.text()).toContain("failed to push some refs");
  });

  it("masks a credential whose key a terminal escape splits", () => {
    const tail = outputTail();
    const esc = String.fromCharCode(27);
    tail.observe(Buffer.from(`pass${esc}[1mword=hunter2secret\n`));
    expect(tail.text()).not.toContain("hunter2secret");
  });

  it("reads a quote after a terminal escape as opening a value, across an overflow", () => {
    const tail = outputTail();
    const esc = String.fromCharCode(27);
    tail.observe(Buffer.from(`password=${esc}[31m"first\n`));
    tail.observe(Buffer.from("filler line\n".repeat(30 * 1024)));
    tail.observe(Buffer.from('ESCSECRET"\nnext line\n'));
    const out = tail.text();
    expect(out).not.toContain("ESCSECRET");
    expect(out).toContain("next line");
  });

  it("reads a doubled quote split between chunks as part of the value", () => {
    const tail = outputTail();
    tail.observe(Buffer.from('password="first\n'));
    tail.observe(Buffer.from("filler line\n".repeat(30 * 1024)));
    tail.observe(Buffer.from('mid"'));
    tail.observe(Buffer.from('"DOUBLESECRET\nSECOND"\nnext line\n'));
    const out = tail.text();
    expect(out).not.toContain("DOUBLESECRET");
    expect(out).not.toContain("SECOND");
    expect(out).toContain("next line");
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
