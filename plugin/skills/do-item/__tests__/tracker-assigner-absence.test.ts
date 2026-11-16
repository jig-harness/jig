import { describe, expect, it } from "bun:test";
import { AssignerUnknown } from "../scripts/lib/tracker/assigner-unknown.ts";
import { GitHubApiError } from "../scripts/lib/tracker/github/transport.ts";
import { JiraApiError } from "../scripts/lib/tracker/jira/transport.ts";
import { gitHub } from "./github-fixtures.ts";
import { FACTORY, issue, jira, routes } from "./jira-fixtures.ts";

describe("assignment absence is an answer, not a failed read", () => {
  const github = (
    nodes: unknown,
    events: unknown[] = [],
    previous: unknown = false,
  ) =>
    gitHub(() => ({
      repository: {
        issue: {
          assignees: { nodes },
          timelineItems: {
            nodes: events,
            pageInfo: { hasPreviousPage: previous },
          },
        },
      },
    })).t;

  it("types GitHub's definite absent and deleted assignment authors", async () => {
    await expect(github([]).assignedBy("#5")).rejects.toBeInstanceOf(
      AssignerUnknown,
    );
    await expect(
      github([{ login: "other" }]).assignedBy("#5", "factory"),
    ).rejects.toBeInstanceOf(AssignerUnknown);
    await expect(
      github([{ login: "factory" }]).assignedBy("#5"),
    ).rejects.toBeInstanceOf(AssignerUnknown);
    const deleted = [
      {
        createdAt: "2026-10-01T00:00:00Z",
        actor: null,
        assignee: { login: "factory" },
      },
    ];
    await expect(
      github([{ login: "factory" }], deleted).assignedBy("#5"),
    ).rejects.toBeInstanceOf(AssignerUnknown);
  });

  it("keeps incomplete or malformed GitHub answers as failures", async () => {
    await expect(
      github([{ login: "factory" }], [], true).assignedBy("#5"),
    ).rejects.toBeInstanceOf(GitHubApiError);
    await expect(
      github([{ login: "factory" }], [], null).assignedBy("#5"),
    ).rejects.toBeInstanceOf(GitHubApiError);
    await expect(github(null).assignedBy("#5")).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });

  it("types Jira's definite absent assignment answers", async () => {
    for (const assignee of [null, FACTORY]) {
      const { t } = jira(
        routes({
          "GET issue/ENG-1": issue({ key: "ENG-1", assignee }),
          "GET issue/ENG-1/changelog": {
            values: [],
            startAt: 0,
            maxResults: 100,
            total: 0,
            isLast: true,
          },
        }),
      );
      await expect(t.assignedBy("ENG-1")).rejects.toBeInstanceOf(
        AssignerUnknown,
      );
    }
  });

  it("keeps a refused Jira history read as a failure", async () => {
    const { t } = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1", assignee: FACTORY }),
        "GET issue/ENG-1/changelog": new JiraApiError("history refused", {
          status: 403,
        }),
      }),
    );
    await expect(t.assignedBy("ENG-1")).rejects.toBeInstanceOf(JiraApiError);
  });

  it("keeps a malformed Jira assignee change as a failure", async () => {
    const entry = (id: string, created: string, items: unknown[]) => ({
      id,
      created,
      author: null,
      items,
    });
    const history = (values: unknown[]) =>
      jira(
        routes({
          "GET issue/ENG-1": issue({ key: "ENG-1", assignee: FACTORY }),
          "GET issue/ENG-1/changelog": {
            values,
            startAt: 0,
            maxResults: 100,
            total: values.length,
            isLast: true,
          },
        }),
      ).t;
    const malformed = entry("2", "2026-10-02T00:00:00Z", [
      { fieldId: "assignee", to: FACTORY.accountId },
    ]);
    await expect(
      history([
        entry("1", "2026-10-01T00:00:00Z", [{ fieldId: "assignee" }]),
      ]).assignedBy("ENG-1"),
    ).rejects.toBeInstanceOf(JiraApiError);
    await expect(
      history([
        entry("1", "2026-10-01T00:00:00Z", [
          { fieldId: "assignee", from: null, to: FACTORY.accountId },
        ]),
        malformed,
      ]).assignedBy("ENG-1"),
    ).rejects.toBeInstanceOf(JiraApiError);
  });
});
