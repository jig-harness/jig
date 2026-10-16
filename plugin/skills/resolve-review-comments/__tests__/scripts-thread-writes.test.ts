/**
 * scripts-thread-writes.test.ts — the resolve-review-comments thread writers
 * (reply-to-thread.ts, resolve-thread.ts, unresolve-thread.ts) against the
 * stubbed `gh` of `scripts-harness.ts`: each write re-reads its PR's liveness,
 * and reply-to-thread.ts posts exactly the body it was given.
 *
 * Subprocess integration tests, like the rest of the script surface in
 * scripts.test.ts — run with `--timeout 30000`.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCRIPTS,
  type Fixture,
  thread,
  writeFixture,
  runScript,
  useStubForge,
} from "./scripts-harness.ts";

useStubForge();

// Every thread write reads its own PR, even after an open round was enumerated.
describe.skipIf(process.platform === "win32")(
  "thread mutation liveness",
  () => {
    const writers = [
      "reply-to-thread.ts",
      "resolve-thread.ts",
      "unresolve-thread.ts",
    ];
    const body = "**accepted** — fixed the guard.\n";
    const events = (fix: Fixture) =>
      readFileSync(join(fix.dir, "thread-events.log"), "utf8")
        .trim()
        .split("\n");

    for (const script of writers) {
      const write = (fix: Fixture) =>
        runScript(script, ["PRRT_x"], fix, {
          stdin: body,
          // A caller's driver target is never evidence of thread ownership.
          env: { DRIVE_PR_TARGET: "99999" },
        });

      // Without a sibling drive, reply-to-thread correctly refuses drive context;
      // these standalone tests therefore keep the ordinary no-drive environment.
      const standaloneWrite = (fix: Fixture) =>
        runScript(script, ["PRRT_x"], fix, { stdin: body });

      it(`${script}: an open PR is read immediately before the write`, () => {
        const fix = writeFixture({ threads: [thread("PRRT_x")] });
        expect(
          runScript("list-unresolved-threads.ts", [fix.pr], fix).code,
        ).toBe(0);
        const r = standaloneWrite(fix);
        expect({ code: r.code, stderr: r.stderr }).toEqual({
          code: 0,
          stderr: "",
        });
        expect(events(fix)).toEqual([
          "enumeration",
          "liveness",
          script === "reply-to-thread.ts" ? "reply" : "resolution",
        ]);
        const query = readFileSync(join(fix.dir, "liveness-calls.log"), "utf8");
        expect(query).toContain("node(id:$threadId)");
        expect(query).toContain("pullRequest { number state }");
        expect(query).toContain("threadId=PRRT_x");
        expect(query).not.toContain("--cache");
      });

      for (const state of ["MERGED", "CLOSED"]) {
        it(`${script}: refuses ${state} after open enumeration`, () => {
          const fix = writeFixture({ threads: [thread("PRRT_x")] });
          expect(
            runScript("await-round.ts", [fix.pr, "--once"], fix).code,
          ).toBe(0);
          expect(
            runScript("list-unresolved-threads.ts", [fix.pr], fix).code,
          ).toBe(0);
          writeFileSync(join(fix.dir, "state"), state);
          const r = standaloneWrite(fix);
          expect(r.code).toBe(5);
          expect(r.stderr).toContain(`owning PR #${fix.pr} is ${state}`);
          expect(r.stderr).toContain("stop the review pass");
          expect(events(fix).at(-1)).toBe("liveness");
          expect(events(fix)).not.toContain("reply");
          expect(events(fix)).not.toContain("resolution");
        });
      }

      it(`${script}: refuses a failed liveness read`, () => {
        const fix = writeFixture({ stateUnreadable: true });
        const r = standaloneWrite(fix);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("cannot read owning PR liveness");
        expect(events(fix)).toEqual(["liveness"]);
      });

      const openNode = {
        __typename: "PullRequestReviewThread",
        id: "PRRT_x",
        pullRequest: { number: 42, state: "OPEN" },
      };
      const invalidResponses = {
        "malformed JSON": "{",
        "null node": JSON.stringify({ data: { node: null } }),
        "wrong node type": JSON.stringify({
          data: { node: { ...openNode, __typename: "Issue" } },
        }),
        "wrong thread": JSON.stringify({
          data: { node: { ...openNode, id: "PRRT_other" } },
        }),
        "missing PR": JSON.stringify({
          data: { node: { ...openNode, pullRequest: null } },
        }),
        "unknown state": JSON.stringify({
          data: {
            node: {
              ...openNode,
              pullRequest: { number: 42, state: "UNKNOWN" },
            },
          },
        }),
        "partial GraphQL error": JSON.stringify({
          data: { node: openNode },
          errors: [{ message: "unreadable" }],
        }),
      };
      for (const [name, response] of Object.entries(invalidResponses)) {
        it(`${script}: refuses ${name}`, () => {
          const fix = writeFixture({});
          writeFileSync(join(fix.dir, "liveness-response.json"), response);
          const r = standaloneWrite(fix);
          expect(r.code).toBe(1);
          expect(r.stderr).toContain("cannot read owning PR liveness");
          expect(events(fix)).toEqual(["liveness"]);
        });
      }

      // Resolution has no optional lease integration; a conflicting driver target
      // must not redirect the owning-PR lookup or permit an otherwise closed PR.
      if (script !== "reply-to-thread.ts") {
        it(`${script}: ignores a different driver's target`, () => {
          const fix = writeFixture({ state: "MERGED" });
          expect(write(fix).code).toBe(5);
          expect(events(fix)).toEqual(["liveness"]);
        });
      }
    }

    for (const script of writers) {
      it(`converge stops after a mid-pass merge refuses ${script}, before follow-up work`, () => {
        const fix = writeFixture({ threads: [thread("PRRT_x")] });
        const passFile = join(fix.dir, "merge-pass.ts");
        const followup = join(fix.dir, "followup-push-would-run");
        writeFileSync(
          passFile,
          `
        import { writeFileSync, appendFileSync } from "node:fs";
        import { spawnSync } from "node:child_process";
        appendFileSync(${JSON.stringify(join(fix.dir, "passes.log"))}, "pass\\n");
        const listed = spawnSync(process.execPath, [${JSON.stringify(join(SCRIPTS, "list-unresolved-threads.ts"))}, process.argv[2]], { encoding: "utf8" });
        if (listed.status !== 0) process.exit(1);
        writeFileSync(${JSON.stringify(join(fix.dir, "state"))}, "MERGED");
        const wrote = spawnSync(process.execPath, [${JSON.stringify(join(SCRIPTS, script))}, "PRRT_x"], { input: ${JSON.stringify(body)}, encoding: "utf8" });
        process.stderr.write(wrote.stderr);
        if (wrote.status !== 0) process.exit(wrote.status ?? 1);
        writeFileSync(${JSON.stringify(followup)}, "unexpected follow-up");
      `,
        );
        const r = runScript(
          "converge.ts",
          [
            fix.pr,
            "--max-rounds",
            "2",
            "--",
            process.execPath,
            passFile,
            fix.pr,
          ],
          fix,
        );
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("is MERGED; refusing mutation");
        expect(r.stderr).toContain("pass failed on round 1");
        expect(readFileSync(join(fix.dir, "passes.log"), "utf8")).toBe(
          "pass\n",
        );
        expect(existsSync(followup)).toBe(false);
        expect(events(fix).at(-1)).toBe("liveness");
        expect(events(fix)).not.toContain("reply");
        expect(events(fix)).not.toContain("resolution");
      });
    }

    it("checks again when the PR merges between reply and resolution", () => {
      const fix = writeFixture({});
      expect(
        runScript("reply-to-thread.ts", ["PRRT_x"], fix, { stdin: body }).code,
      ).toBe(0);
      writeFileSync(join(fix.dir, "state"), "MERGED");
      expect(runScript("resolve-thread.ts", ["PRRT_x"], fix).code).toBe(5);
      expect(events(fix)).toEqual(["liveness", "reply", "liveness"]);
    });
  },
);

// ── reply-to-thread.ts: the posting chokepoint ──────────────────────────────

describe.skipIf(process.platform === "win32")(
  "reply-to-thread.ts posting",
  () => {
    function postedBodies(fix: Fixture): string[] {
      return readdirSync(fix.dir)
        .filter((f) => f.startsWith("graphql-input-"))
        .sort()
        .map((f) => {
          const doc = JSON.parse(readFileSync(join(fix.dir, f), "utf8")) as {
            query: string;
            variables: { threadId: string; body: string };
          };
          expect(doc.query).toContain("addPullRequestReviewThreadReply");
          return doc.variables.body;
        });
    }

    it("delivers the body VERBATIM — shell metacharacters, backticks, trailing blank line", () => {
      const fix = writeFixture({});
      // Every character class a shell would expand or strip: expansion
      // syntax, backticks, quotes — plus a deliberate trailing blank line,
      // which command substitution (`$(cat)`) would drop.
      const body =
        "**accepted** — handled `$(rm -rf /)` and $VAR and `backticks` in abc1234.\n\n";
      const r = runScript("reply-to-thread.ts", ["PRRT_x"], fix, {
        stdin: body,
      });
      expect({ code: r.code, stdout: r.stdout.trim() }).toEqual({
        code: 0,
        stdout: "https://github.com/acme/widgets/pull/1#discussion_r1",
      });
      expect(postedBodies(fix)).toEqual([body]);
    });

    it("refuses a non-outcome body before anything reaches the API", () => {
      const fix = writeFixture({});
      const r = runScript("reply-to-thread.ts", ["PRRT_x"], fix, {
        stdin: "looks fine to me",
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("must begin with an outcome token");
      expect(postedBodies(fix)).toEqual([]);
    });

    it("--no-outcome is the explicit escape hatch for a clarifying question, and appends NO_OUTCOME_MARKER — the durable evidence isLeftOpenThread requires", () => {
      const fix = writeFixture({});
      const body = "Which schema version is this rule pinned to?";
      const r = runScript(
        "reply-to-thread.ts",
        ["PRRT_x", "--no-outcome"],
        fix,
        {
          stdin: body,
        },
      );
      expect(r.code).toBe(0);
      expect(postedBodies(fix)).toEqual([
        `${body}\n\n<!-- reply-to-thread:no-outcome -->`,
      ]);
    });

    it("refuses a body whose own trailing line already matches NO_OUTCOME_MARKER — this script is the sole producer, so nothing legitimately supplies it", () => {
      const fix = writeFixture({});
      const body =
        "Which schema version is this rule pinned to?\n\n<!-- reply-to-thread:no-outcome -->";
      const r = runScript(
        "reply-to-thread.ts",
        ["PRRT_x", "--no-outcome"],
        fix,
        {
          stdin: body,
        },
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("NO_OUTCOME_MARKER");
      expect(postedBodies(fix)).toEqual([]);
    });

    it("exit 2: no thread id, an empty stdin body, or a stale body-as-argument call", () => {
      const fix = writeFixture({});
      expect(
        runScript("reply-to-thread.ts", [], fix, { stdin: "x" }).code,
      ).toBe(2);
      expect(
        runScript("reply-to-thread.ts", ["PRRT_x"], fix, { stdin: "" }).code,
      ).toBe(2);
      // Arity, not emptiness: an explicitly empty second argument is the same
      // stale two-argument form.
      expect(
        runScript("reply-to-thread.ts", ["PRRT_x", ""], fix, { stdin: "x" })
          .code,
      ).toBe(2);
      expect(
        runScript("reply-to-thread.ts", ["PRRT_x", "**accepted** — b."], fix, {
          stdin: "x",
        }).code,
      ).toBe(2);
      expect(postedBodies(fix)).toEqual([]);
    });

    it("refuses a body whose own trailing line already matches LEAVE_OPEN_MARKER, without the internal producer flag", () => {
      const fix = writeFixture({});
      const body =
        "**wont-fix** — declined; this reply happens to end with the exact marker line.\n\n<!-- triage-thread:leave-open -->";
      const r = runScript("reply-to-thread.ts", ["PRRT_x"], fix, {
        stdin: body,
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("LEAVE_OPEN_MARKER");
      expect(postedBodies(fix)).toEqual([]);
    });

    it("posts the same marker-ending body fine WITH DRIVE_PR_INTERNAL_LEAVE_OPEN_MARKER=1 — the flag triage-thread.ts sets on its own single call site", () => {
      const fix = writeFixture({});
      const body =
        "**wont-fix** — declined; this reply happens to end with the exact marker line.\n\n<!-- triage-thread:leave-open -->";
      const r = runScript("reply-to-thread.ts", ["PRRT_x"], fix, {
        stdin: body,
        env: { DRIVE_PR_INTERNAL_LEAVE_OPEN_MARKER: "1" },
      });
      expect(r.code).toBe(0);
      expect(postedBodies(fix)).toEqual([body]);
    });

    it("does not refuse an ordinary body that never mentions the marker, regardless of the flag", () => {
      const fix = writeFixture({});
      const body = "**wont-fix** — declined, plain and simple.";
      const r = runScript("reply-to-thread.ts", ["PRRT_x"], fix, {
        stdin: body,
      });
      expect(r.code).toBe(0);
      expect(postedBodies(fix)).toEqual([body]);
    });
  },
);
