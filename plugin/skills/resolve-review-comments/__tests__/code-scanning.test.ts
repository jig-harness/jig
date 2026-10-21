/**
 * code-scanning.test.ts — code-scanning threads: recognising the alert
 * behind one, reading its severity, attaching it to the thread listing, and
 * dismissing it through dismiss-alert.ts against the stubbed `gh` of
 * scripts-harness.ts.
 *
 * Subprocess integration tests, like the rest of the script surface in
 * scripts.test.ts — run with `--timeout 30000`.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alertNumberOf, summarizeAlert } from "../scripts/lib/code-scanning.ts";
import {
  type Fixture,
  runScript,
  useStubForge,
  writeFixture,
} from "./scripts-harness.ts";

useStubForge();

const LINK = "https://github.com/acme/widgets/security/code-scanning/7";
const BODY = `## SonarCloud / Paths should not come from arguments\n\nPath traversal.\n\n[Show more details](${LINK})`;

describe("alertNumberOf", () => {
  it("reads the alert a code scanning comment links", () => {
    expect(
      alertNumberOf(BODY, "github-advanced-security", "acme", "widgets"),
    ).toBe(7);
    expect(
      alertNumberOf(BODY, "github-advanced-security[bot]", "Acme", "Widgets"),
    ).toBe(7);
  });

  it("refuses the same link from any other author", () => {
    expect(alertNumberOf(BODY, "somebot[bot]", "acme", "widgets")).toBeNull();
    expect(alertNumberOf(BODY, null, "acme", "widgets")).toBeNull();
  });

  it("refuses an alert of another repository", () => {
    expect(
      alertNumberOf(BODY, "github-advanced-security", "acme", "gadgets"),
    ).toBeNull();
    expect(
      alertNumberOf(
        BODY.replace("acme/widgets", "other/widgets"),
        "github-advanced-security",
        "acme",
        "widgets",
      ),
    ).toBeNull();
  });

  it("refuses a comment with no alert link", () => {
    expect(
      alertNumberOf("a finding", "github-advanced-security", "acme", "widgets"),
    ).toBeNull();
  });
});

describe("summarizeAlert", () => {
  const alert = (rule: Record<string, unknown>, state: unknown = "open") => ({
    state,
    rule: { id: "ts:S1", ...rule },
    tool: { name: "SonarCloud" },
    most_recent_instance: { state: "open" },
  });

  const cases: [string, Record<string, unknown>, string, string][] = [
    [
      "critical",
      { security_severity_level: "critical" },
      "blocker",
      "security",
    ],
    [
      "high",
      { security_severity_level: "high", severity: "warning" },
      "high",
      "security",
    ],
    ["medium", { security_severity_level: "medium" }, "medium", "security"],
    ["low", { security_severity_level: "low" }, "low", "security"],
    ["error", { severity: "error" }, "high", "unknown"],
    ["warning", { severity: "warning" }, "medium", "unknown"],
    ["note", { severity: "note" }, "low", "unknown"],
    ["an unknown level", { severity: "loud" }, "unknown", "unknown"],
  ];
  for (const [label, rule, severity, category] of cases) {
    it(`maps ${label}`, () => {
      const s = summarizeAlert(7, alert(rule));
      expect<string[]>([s.severity, s.category]).toEqual([severity, category]);
    });
  }

  it("takes the instance's state for an alert raised only on a pull request", () => {
    expect(summarizeAlert(7, alert({}, null)).state).toBe("open");
  });

  it("names the tool and rule", () => {
    const s = summarizeAlert(7, alert({ severity: "error" }, "dismissed"));
    expect(s).toEqual({
      number: 7,
      state: "dismissed",
      tool: "SonarCloud",
      rule: "ts:S1",
      severity: "high",
      category: "unknown",
    });
  });
});

/** A thread GitHub opened for alert 7, as the GraphQL listing returns it. */
function codeScanningThread(id: string, body = BODY) {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    diffSide: "RIGHT",
    startDiffSide: null,
    path: "a.ts",
    line: 1,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          url: `https://github.com/acme/widgets/pull/1#discussion_${id}`,
          author: { login: "github-advanced-security", __typename: "Bot" },
          authorAssociation: "NONE",
          body,
        },
      ],
    },
  };
}

const writeAlert = (fix: Fixture, state: string | null) =>
  writeFileSync(
    join(fix.dir, "alert-7.json"),
    JSON.stringify({
      number: 7,
      state,
      rule: {
        id: "tssecurity:S8707",
        severity: "warning",
        security_severity_level: "high",
      },
      tool: { name: "SonarCloud" },
      most_recent_instance: { state: state ?? "open" },
    }),
  );

/** The thread read as `gh -q` hands it over: repository, author, body. */
const writeThreadNode = (fix: Fixture, author: string, body = BODY) =>
  writeFileSync(
    join(fix.dir, "thread-node.json"),
    JSON.stringify(["acme", "widgets", author, body]),
  );

describe.skipIf(process.platform === "win32")(
  "list-unresolved-threads.ts on a code-scanning thread",
  () => {
    const listed = (fix: Fixture) => {
      const r = runScript("list-unresolved-threads.ts", [fix.pr], fix);
      return {
        code: r.code,
        stderr: r.stderr,
        records: r.stdout
          .trim()
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l)),
      };
    };

    it("attaches the alert", () => {
      const fix = writeFixture({ threads: [codeScanningThread("PRRT_cs")] });
      writeAlert(fix, null);
      const r = listed(fix);
      expect(r.code).toBe(0);
      expect(r.records[0].codeScanning).toEqual({
        number: 7,
        state: "open",
        tool: "SonarCloud",
        rule: "tssecurity:S8707",
        severity: "high",
        category: "security",
      });
    });

    it("still lists the thread when the alert cannot be read", () => {
      const fix = writeFixture({ threads: [codeScanningThread("PRRT_cs")] });
      const r = listed(fix);
      expect(r.code).toBe(0);
      expect(r.records[0].threadId).toBe("PRRT_cs");
      expect(r.records[0].codeScanning.severity).toBe("unknown");
      expect(r.records[0].codeScanning.unreadable).toContain("HTTP 403");
      expect(r.stderr).toContain("alert 7 could not be read");
    });

    it("reads no alert under --no-alerts", () => {
      const fix = writeFixture({ threads: [codeScanningThread("PRRT_cs")] });
      writeAlert(fix, "open");
      const r = runScript(
        "list-unresolved-threads.ts",
        [fix.pr, "--no-alerts"],
        fix,
      );
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).codeScanning).toBeUndefined();
      expect(existsSync(join(fix.dir, "alert-calls.log"))).toBe(false);
    });

    it("reads no alert for a thread another account opened", () => {
      const thread = codeScanningThread("PRRT_cs");
      const opening = thread.comments.nodes[0];
      if (opening) opening.author.login = "somebot";
      const fix = writeFixture({ threads: [thread] });
      writeAlert(fix, "open");
      const r = listed(fix);
      expect(r.code).toBe(0);
      expect(r.records[0].codeScanning).toBeUndefined();
      expect(existsSync(join(fix.dir, "alert-calls.log"))).toBe(false);
    });
  },
);

describe.skipIf(process.platform === "win32")("dismiss-alert.ts", () => {
  const dismiss = (fix: Fixture, args: string[], stdin = "not reachable") =>
    runScript("dismiss-alert.ts", ["PRRT_cs", ...args], fix, { stdin });
  const sent = (fix: Fixture) =>
    readFileSync(join(fix.dir, "dismiss-args.log"), "utf8").trim().split("\n");

  const outcomes: [string[], string][] = [
    [["--outcome", "rejected"], "false positive"],
    [["--outcome", "rejected", "--used-in-tests"], "used in tests"],
    [["--outcome", "wont-fix"], "won't fix"],
    [["--outcome", "deferred"], "won't fix"],
  ];
  for (const [args, reason] of outcomes) {
    it(`dismisses ${args.join(" ")} as ${reason}`, () => {
      const fix = writeFixture({});
      writeThreadNode(fix, "github-advanced-security");
      writeAlert(fix, "open");
      const r = dismiss(fix, args, "only tests reach it\n");
      expect({ code: r.code, stdout: r.stdout, stderr: r.stderr }).toEqual({
        code: 0,
        stdout: "dismissed\n",
        stderr: "",
      });
      expect(sent(fix)).toEqual([
        "api",
        "-X",
        "PATCH",
        "repos/acme/widgets/code-scanning/alerts/7",
        "-f",
        "state=dismissed",
        "-f",
        `dismissed_reason=${reason}`,
        "-f",
        "dismissed_comment=only tests reach it",
        "-q",
        ".state",
      ]);
    });
  }

  it("reads the pull request's liveness just before dismissing", () => {
    const fix = writeFixture({});
    writeThreadNode(fix, "github-advanced-security");
    writeAlert(fix, "open");
    expect(dismiss(fix, ["--outcome", "rejected"]).code).toBe(0);
    expect(
      readFileSync(join(fix.dir, "thread-events.log"), "utf8").trim(),
    ).toBe("liveness\ndismissal");
  });

  it("refuses on a merged pull request", () => {
    const fix = writeFixture({ state: "MERGED" });
    writeThreadNode(fix, "github-advanced-security");
    writeAlert(fix, "open");
    expect(dismiss(fix, ["--outcome", "rejected"]).code).toBe(5);
    expect(existsSync(join(fix.dir, "dismiss-args.log"))).toBe(false);
  });

  it("refuses a thread another account opened", () => {
    const fix = writeFixture({});
    writeThreadNode(fix, "somebot");
    writeAlert(fix, "open");
    const r = dismiss(fix, ["--outcome", "rejected"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not a code-scanning thread");
    expect(existsSync(join(fix.dir, "dismiss-args.log"))).toBe(false);
  });

  it("refuses a fixed alert: its outcome is accepted or moot", () => {
    const fix = writeFixture({});
    writeThreadNode(fix, "github-advanced-security");
    writeAlert(fix, "fixed");
    const r = dismiss(fix, ["--outcome", "rejected"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("alert 7 is fixed");
    expect(existsSync(join(fix.dir, "dismiss-args.log"))).toBe(false);
  });

  it("leaves an already dismissed alert alone", () => {
    const fix = writeFixture({});
    writeThreadNode(fix, "github-advanced-security");
    writeAlert(fix, "dismissed");
    const r = dismiss(fix, ["--outcome", "rejected"]);
    expect({ code: r.code, stdout: r.stdout }).toEqual({
      code: 0,
      stdout: "dismissed\n",
    });
    expect(existsSync(join(fix.dir, "dismiss-args.log"))).toBe(false);
  });

  it("fails when GitHub refuses the dismissal", () => {
    const fix = writeFixture({});
    writeThreadNode(fix, "github-advanced-security");
    writeAlert(fix, "open");
    writeFileSync(join(fix.dir, "dismiss-forbidden"), "");
    const r = dismiss(fix, ["--outcome", "rejected"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HTTP 403");
  });

  const usage: [string, string[], string][] = [
    ["no outcome", [], "a reason"],
    ["an unknown flag", ["--outcome", "rejected", "--force"], "a reason"],
    ["a second thread", ["PRRT_other", "--outcome", "rejected"], "a reason"],
    [
      "an outcome that is not a dismissal",
      ["--outcome", "accepted"],
      "a reason",
    ],
    [
      "--used-in-tests without rejected",
      ["--outcome", "wont-fix", "--used-in-tests"],
      "a reason",
    ],
    ["an empty comment", ["--outcome", "rejected"], "  \n"],
    [
      "a comment GitHub would refuse",
      ["--outcome", "rejected"],
      "x".repeat(281),
    ],
  ];
  for (const [label, args, stdin] of usage) {
    it(`refuses ${label}`, () => {
      const fix = writeFixture({});
      writeThreadNode(fix, "github-advanced-security");
      writeAlert(fix, "open");
      expect(dismiss(fix, args, stdin).code).toBe(2);
      expect(existsSync(join(fix.dir, "dismiss-args.log"))).toBe(false);
    });
  }
});
