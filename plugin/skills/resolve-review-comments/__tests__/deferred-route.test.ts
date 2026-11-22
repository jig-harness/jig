/**
 * Deferral without a tracker: what an entry records, checked against the
 * review taxonomy, and the route a deferral takes by adapter.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExited } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { deferralRoute, recordedError } from "../scripts/defer-in-pr.ts";
import {
  deferredEntries,
  withDeferredEntry,
  withFiledEntry,
} from "../scripts/lib/deferred-section.ts";
import { PR_URL } from "./deferred-forge.ts";

const THREAD = `${PR_URL}#discussion_r1001`;
const FINDING =
  "The retry budget is read without validation.\n\nIt can go negative.";
/** What an entry records to be filed as. */
const REC = { type: "bug", severity: "high", category: "correctness" };

describe("what an entry records", () => {
  test("is written into the entry's marker and read back; an older entry records none", () => {
    const body = withDeferredEntry("", {
      ...REC,
      size: "medium",
      source: THREAD,
      finding: FINDING,
      reason: "r",
    }).body;
    expect(body).toContain(
      `<!-- deferred-entry: ${THREAD} type=bug severity=high category=correctness size=medium -->`,
    );
    const [entry] = deferredEntries(body);
    expect(entry).toMatchObject({ ...REC, size: "medium" });
    const filed = deferredEntries(
      withFiledEntry(body, { source: THREAD }, { key: "#9", url: null }),
    )[0];
    expect(filed).toMatchObject({ ...REC, filed: { key: "#9", url: null } });
    const old = deferredEntries(
      withDeferredEntry("", { source: THREAD, finding: FINDING, reason: "r" })
        .body,
    )[0];
    expect(old?.type).toBeUndefined();
    expect(old?.severity).toBeUndefined();
  });

  test("is checked against the review taxonomy and the severity vocabulary", () => {
    const vocabulary = { types: ["bug", "docs"], categories: ["correctness"] };
    expect(recordedError(REC, vocabulary)).toBeNull();
    expect(recordedError({ ...REC, type: "spike" }, vocabulary)).toContain(
      "--type must be one of bug|docs",
    );
    expect(
      recordedError({ ...REC, severity: "critical" }, vocabulary),
    ).toContain("--severity must be one of low|medium|high|blocker|unknown");
    expect(recordedError({ ...REC, category: "style" }, vocabulary)).toContain(
      "--category must be one of correctness|unknown",
    );
    expect(recordedError({ ...REC, size: "a b" }, vocabulary)).toContain(
      "--size must be one token",
    );
  });

  test("the command line refuses a deferral that records no type", async () => {
    const proc = Bun.spawn(
      scriptArgv(
        join(import.meta.dir, "..", "scripts", "defer-in-pr.ts"),
        "42",
        "--thread-url",
        THREAD,
        "--severity",
        "high",
        "--category",
        "unknown",
        "--reason",
        "later",
      ),
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    proc.stdin.end();
    const err = await new Response(proc.stderr).text();
    await expectSpawnExited(proc, 2);
    expect(err).toContain("--type <type>");
  });
});

describe("the route a deferral takes", () => {
  test("the batch step on GitHub and a configured Jira adapter", () => {
    expect(
      deferralRoute({ issue_tracker: { adapter: "github" } }, {}).route,
    ).toBe("defer-batch");
    expect(
      deferralRoute(
        {
          issue_tracker: {
            adapter: "jira",
            team: "JIG",
            jira: { site: "https://example.atlassian.net" },
          },
        },
        {},
      ).route,
    ).toBe("defer-batch");
    expect(deferralRoute({}, {}).route).toBe("defer-batch");
  });

  test("the pull request body for a Jira adapter that cannot file", () => {
    expect(
      deferralRoute({ issue_tracker: { adapter: "jira" } }, {}).route,
    ).toBe("pr-body");
  });

  test("the pull request body on Linear with no credential", () => {
    expect(
      deferralRoute({ issue_tracker: { adapter: "linear" } }, {}).route,
    ).toBe("pr-body");
  });

  test("the batch step on Linear with a credential", () => {
    expect(
      deferralRoute(
        { issue_tracker: { adapter: "linear" } },
        { LINEAR_API_KEY: "x" },
      ).route,
    ).toBe("defer-batch");
  });

  test("the command line prints the route", async () => {
    const proc = Bun.spawn(
      scriptArgv(
        join(import.meta.dir, "..", "scripts", "defer-in-pr.ts"),
        "route",
      ),
      {
        env: { ...process.env, JIG__ISSUE_TRACKER__ADAPTER: "github" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(proc.stdout).text();
    await expectSpawnExited(proc, 0);
    expect(out).toBe("defer-batch\n");
  });
});
