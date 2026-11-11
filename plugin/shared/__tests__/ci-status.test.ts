/**
 * Commit statuses as a CI repair reads them: an aborted build is no failure,
 * a status keeps the page it links to, and the two repository values a
 * status-reporting CI service needs are checked when read.
 */
import { describe, expect, it } from "bun:test";
import {
  type CommitStatus,
  ciRepairSettings,
  combinedStatuses,
  failingStatus,
  isAbortedStatus,
  isFailingStatus,
} from "../ci-status.ts";

const status = (
  state: string,
  description: string | null,
  targetUrl?: string | null,
): CommitStatus => ({
  context: "continuous-integration/jenkins/pr-merge",
  state,
  description,
  ...(targetUrl === undefined ? {} : { targetUrl }),
});

describe("a commit status's state", () => {
  it("reads an error whose description says the build was aborted as cancelled", () => {
    for (const description of [
      "The build of this commit was aborted",
      "Build ABORTED by user",
      "Build cancelled",
      "Job canceled",
    ]) {
      expect(isAbortedStatus(status("error", description))).toBe(true);
      expect(isFailingStatus(status("error", description))).toBe(false);
    }
  });

  it("reads any other error or failure as failing", () => {
    for (const s of [
      status("error", "Something is wrong with the build of this commit"),
      status("error", null),
      status("failure", "This commit cannot be built"),
      // Only an error says nothing about the code: a failure stays one
      // whatever its description says.
      status("failure", "The build of this commit was aborted"),
    ]) {
      expect(isAbortedStatus(s)).toBe(false);
      expect(isFailingStatus(s)).toBe(true);
    }
  });

  it("reads success and pending as not failing", () => {
    expect(isFailingStatus(status("success", "This commit looks good"))).toBe(
      false,
    );
    expect(
      isFailingStatus(status("pending", "This commit is being built")),
    ).toBe(false);
  });

  it("tells a repair the status's context and URL", () => {
    expect(
      failingStatus(status("failure", "", "https://ci.example/job/pr-7/3/")),
    ).toEqual({
      context: "continuous-integration/jenkins/pr-merge",
      target_url: "https://ci.example/job/pr-7/3/",
    });
    expect(failingStatus(status("failure", ""))).toEqual({
      context: "continuous-integration/jenkins/pr-merge",
      target_url: null,
    });
  });
});

describe("combinedStatuses", () => {
  it("keeps every page's statuses with the page each links to", () => {
    const pages = [
      {
        state: "failure",
        statuses: [
          {
            context: "build",
            state: "failure",
            description: "This commit cannot be built",
            target_url: "https://ci.example/job/pr-7/3/",
          },
        ],
      },
      {
        state: "failure",
        statuses: [{ context: "lint", state: "success", description: null }],
      },
    ];
    expect(combinedStatuses(JSON.stringify(pages))).toEqual([
      {
        context: "build",
        state: "failure",
        description: "This commit cannot be built",
        targetUrl: "https://ci.example/job/pr-7/3/",
      },
      { context: "lint", state: "success", description: null, targetUrl: null },
    ]);
  });

  it("is null for output that is not JSON", () => {
    expect(combinedStatuses("<html>")).toBeNull();
  });

  it("is null for JSON that is not the advertised shape", () => {
    for (const raw of [
      "{}",
      "null",
      '[{"statuses":null}]',
      '{"statuses":{}}',
      '{"statuses":[null]}',
      '{"statuses":["x"]}',
    ])
      expect(combinedStatuses(raw)).toBeNull();
  });
});

describe("ciRepairSettings", () => {
  const source = (field: string) => `the file (${field})`;

  it("reads both values, and neither when the section is absent", () => {
    expect(ciRepairSettings({}, source)).toEqual({
      ok: true,
      value: { logCommand: undefined, repairSkill: undefined },
    });
    expect(
      ciRepairSettings(
        {
          ci: {
            log_command: "bun scripts/ci-log.ts",
            repair_skill: "ci-support",
          },
        },
        source,
      ),
    ).toEqual({
      ok: true,
      value: {
        logCommand: "bun scripts/ci-log.ts",
        repairSkill: "ci-support",
      },
    });
  });

  it("accepts a plugin's skill", () => {
    const read = ciRepairSettings(
      { ci: { repair_skill: "jig:fix-ci" } },
      source,
    );
    expect(read.ok && read.value.repairSkill).toBe("jig:fix-ci");
  });

  it("refuses a value of the wrong shape, naming where it was set", () => {
    for (const [ci, field] of [
      [{ log_command: "" }, "ci.log_command"],
      [{ log_command: ["bun", "x"] }, "ci.log_command"],
      [{ repair_skill: "/ci-support" }, "ci.repair_skill"],
      [{ repair_skill: "ci support" }, "ci.repair_skill"],
      [{ repair_skill: 3 }, "ci.repair_skill"],
    ] as const) {
      const read = ciRepairSettings({ ci }, source);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.failure.code).toBe("invalid-config");
        expect(read.failure.reason).toContain(`the file (${field})`);
      }
    }
    expect(ciRepairSettings({ ci: "x" }, source).ok).toBe(false);
  });
});
