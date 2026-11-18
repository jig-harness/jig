import { JigError } from "../../../shared/outcome.ts";
import { describe, expect, test } from "bun:test";
import type {
  Issue,
  IssuePatch,
  NewIssue,
  Tracker,
} from "../../do-item/scripts/lib/tracker/port.ts";
import { deferToTracker } from "../scripts/lib/tracker-defer-batch.ts";
import { fileDeferred } from "../scripts/file-deferred.ts";
import { withDeferredEntry } from "../scripts/lib/deferred-section.ts";
import { fakeForge, PR_URL } from "./deferred-forge.ts";
import {
  conn,
  gitHub,
  issueNode,
  oneIssue,
} from "../../do-item/__tests__/github-fixtures.ts";

function must<T>(value: T | null | undefined): T {
  if (value == null) throw new JigError("test", "Missing fixture value");
  return value;
}

function fixture(adapter: string) {
  const issues = new Map<string, Issue>();
  const created: NewIssue[] = [];
  const links: string[][] = [];
  const issue = (key: string, input: Partial<Issue> = {}): Issue => ({
    id: key,
    identifier: key,
    title: key,
    description: "",
    url: `https://example.test/${key}`,
    state: { name: "Backlog", type: "backlog" },
    labels: [],
    nativeType: null,
    isEpic: false,
    type: null,
    priority: 0,
    size: null,
    parent: null,
    children: [],
    assignee: null,
    project: null,
    ...input,
  });
  issues.set("SRC-1", issue("SRC-1", { parent: { identifier: "SRC-2" } }));
  issues.set("SRC-2", issue("SRC-2", { nativeType: "Epic", isEpic: true }));
  const tracker = {
    adapter,
    team: "EX",
    async searchIssues() {
      return [...issues.values()].filter((i) =>
        i.description.includes("defer-batch-key"),
      );
    },
    async getIssue(key: string) {
      return issues.get(key) ?? null;
    },
    async createIssue(input: NewIssue) {
      created.push(input);
      const key = `NEW-${created.length}`;
      issues.set(
        key,
        issue(key, {
          title: input.title,
          description: input.description,
          labels: input.labels,
          type: input.type ?? null,
          priority: input.priority ?? 0,
          size: input.size ?? null,
        }),
      );
      return { identifier: key, url: `https://example.test/${key}` };
    },
    async updateIssue(key: string, patch: IssuePatch) {
      const live = must(issues.get(key));
      Object.assign(live, patch);
      live.labels = [...new Set([...live.labels, ...(patch.addLabels ?? [])])];
    },
    async transition(key: string) {
      must(issues.get(key)).state = { name: "Backlog", type: "backlog" };
    },
    async listRelations(key: string) {
      return links
        .filter((l) => l[0] === key)
        .map((l) => ({ type: "related", issue: must(l[2]) }));
    },
    async relate(key: string, type: string, target: string) {
      links.push([key, type, target]);
    },
  } as unknown as Tracker;
  return { tracker, created, issues, links };
}

describe("tracker-independent deferral batches", () => {
  test("fallback retry repairs an issue created before its related link failed", async () => {
    const f = fixture("github");
    const relate = f.tracker.relate;
    let fail = true;
    f.tracker.relate = async (...args) => {
      if (fail) {
        fail = false;
        throw new JigError("test", "temporary relation failure");
      }
      return relate(...args);
    };
    const forge = fakeForge(
      withDeferredEntry("Refs SRC-1", {
        source: `${PR_URL}#discussion_r1`,
        type: "bug",
        severity: "high",
        category: "correctness",
        finding: "A finding",
        reason: "later",
      }).body,
    );
    expect(
      (
        await fileDeferred(forge, f.tracker, "42", {
          label: "pr-followup",
          facets: null,
        })
      ).why,
    ).toContain("temporary relation failure");
    const retry = await fileDeferred(forge, f.tracker, "42", {
      label: "pr-followup",
      facets: null,
    });
    expect(retry.why).toBeNull();
    expect(f.created).toHaveLength(1);
    expect(f.links).toContainEqual(["NEW-1", "related", "SRC-2"]);
  });

  test("old Linear headings and normalized Markdown links do not duplicate a finding", async () => {
    const f = fixture("linear");
    const input = {
      repo: "example/project",
      pr: "42",
      type: "bug",
      identity: `Deferred finding: ${PR_URL}#discussion_r1`,
      text: "A finding",
      category: "correctness",
      priority: 3,
      labels: ["pr-followup"],
    };
    const first = await deferToTracker(f.tracker, input);
    const issue = must(f.issues.get(first.identifier));
    issue.description = `<!-- defer-batch-key: repo=example/project pr=42 type=bug -->\n\n## Entries\n\n### [${PR_URL}#discussion_r1](<${PR_URL}#discussion_r1>)\n\nA finding\n`;
    const retried = await deferToTracker(f.tracker, input);
    expect(retried.alreadyPresent).toBe(true);
    expect(issue.description.match(/A finding/g)).toHaveLength(1);
    issue.description = issue.description.replace(
      input.identity,
      `Deferred finding: [${PR_URL}#discussion_r1](<${PR_URL}#discussion_r1>)`,
    );
    await deferToTracker(f.tracker, input);
    expect(issue.description.match(/A finding/g)).toHaveLength(1);
  });

  for (const adapter of ["github", "linear", "jira"]) {
    test(`${adapter}: three findings of two types form two backlog issues, with union labels and highest priority`, async () => {
      const f = fixture(adapter);
      const base = {
        repo: "example/project",
        pr: "42",
        type: "bug",
        size: "small",
        originating: "SRC-1",
      };
      const first = await deferToTracker(f.tracker, {
        ...base,
        identity: "one",
        text: "first finding",
        category: "correctness",
        priority: 4,
        labels: ["pr-followup", "area:a"],
      });
      const second = await deferToTracker(f.tracker, {
        ...base,
        identity: "two",
        text: "second finding",
        category: "security",
        priority: 2,
        labels: ["pr-followup", "area:b"],
      });
      await deferToTracker(f.tracker, {
        ...base,
        type: "feature",
        identity: "three",
        text: "third finding",
        category: "usability",
        priority: 3,
        labels: ["pr-followup", "area:c"],
      });
      expect(first.identifier).toBe(second.identifier);
      expect(f.created).toHaveLength(2);
      expect(f.created.every((i) => i.parent === undefined)).toBe(true);
      const batch = must(f.issues.get(first.identifier));
      expect(batch.priority).toBe(2);
      expect(batch.labels).toEqual(["pr-followup", "area:a", "area:b"]);
      expect(batch.description).toContain("correctness, security");
      expect(batch.description).toContain("first finding");
      expect(batch.description).toContain("second finding");
      expect(f.links).toContainEqual([first.identifier, "related", "SRC-1"]);
      expect(f.links).toContainEqual([first.identifier, "related", "SRC-2"]);
      expect(batch.state.type).toBe("backlog");
    });
  }

  test("retry is idempotent, and a closed batch is never appended to", async () => {
    const f = fixture("github");
    const input = {
      repo: "example/project",
      pr: "42",
      type: "bug",
      identity: "one",
      text: "finding",
      category: "correctness",
      priority: 3,
      labels: ["pr-followup"],
    };
    const first = await deferToTracker(f.tracker, input);
    await deferToTracker(f.tracker, input);
    expect(f.created).toHaveLength(1);
    expect(
      must(f.issues.get(first.identifier)).description.split("\nfinding\n"),
    ).toHaveLength(2);
    must(f.issues.get(first.identifier)).state.type = "completed";
    await deferToTracker(f.tracker, input);
    expect(f.created).toHaveLength(2);
  });

  test("a mixed-size batch preserves its established required size and records both findings", async () => {
    const f = fixture("github");
    const common = {
      repo: "example/project",
      pr: "42",
      type: "bug",
      category: "correctness",
      priority: 3,
      labels: ["pr-followup"],
    };
    const first = await deferToTracker(f.tracker, {
      ...common,
      identity: "small finding",
      text: "small finding",
      size: "small",
    });
    await deferToTracker(f.tracker, {
      ...common,
      identity: "xs finding",
      text: "xs finding",
      size: "xs",
    });
    const batch = must(f.issues.get(first.identifier));
    expect(batch.size).toBe("small");
    expect(batch.description).toContain("small finding");
    expect(batch.description).toContain("xs finding");
  });

  test("the real GitHub reader recognizes the native Epic type without an epic label", async () => {
    const actual = gitHub(
      () =>
        oneIssue(
          issueNode({
            number: 2,
            issueType: "Epic",
            extra: { subIssues: conn([]) },
          }),
        ),
      { issue_tracker: { labels: { epic_types: ["Epic"] } } },
    ).t;
    const native = await actual.getIssue("#2");
    expect(native?.isEpic).toBe(true);
    const f = fixture("github");
    f.issues.set("SRC-2", must(native));
    const batch = await deferToTracker(f.tracker, {
      repo: "example/project",
      pr: "42",
      type: "bug",
      identity: "one",
      text: "finding",
      category: "correctness",
      priority: 3,
      labels: ["pr-followup"],
      originating: "SRC-1",
    });
    expect(f.links).toContainEqual([batch.identifier, "related", "#2"]);
  });

  test("a failed backlog transition and partial related links are repaired by the next run", async () => {
    const f = fixture("github");
    const create = f.tracker.createIssue;
    f.tracker.createIssue = async (input) => {
      const made = await create(input);
      must(f.issues.get(made.identifier)).state.type = "unstarted";
      return made;
    };
    const transition = f.tracker.transition;
    let fail = true;
    f.tracker.transition = async (...args) => {
      if (fail) {
        fail = false;
        throw new JigError("test", "temporary transition failure");
      }
      return transition(...args);
    };
    const input = {
      repo: "example/project",
      pr: "42",
      type: "bug",
      identity: "one",
      text: "finding",
      category: "correctness",
      priority: 3,
      labels: ["pr-followup"],
      originating: "SRC-1",
    };
    await expect(deferToTracker(f.tracker, input)).rejects.toThrow(
      "temporary transition failure",
    );
    const made = await deferToTracker(f.tracker, input);
    expect(f.created).toHaveLength(1);
    expect(must(f.issues.get(made.identifier)).state.type).toBe("backlog");
    expect(f.links).toContainEqual([made.identifier, "related", "SRC-2"]);
  });

  test("a transition that does not persist cannot produce a ready deferral link", async () => {
    const f = fixture("github");
    const create = f.tracker.createIssue;
    f.tracker.createIssue = async (input) => {
      const made = await create(input);
      must(f.issues.get(made.identifier)).state.type = "unstarted";
      return made;
    };
    f.tracker.transition = async () => undefined;
    await expect(
      deferToTracker(f.tracker, {
        repo: "example/project",
        pr: "42",
        type: "bug",
        identity: "one",
        text: "finding",
        category: "correctness",
        priority: 3,
        labels: ["pr-followup"],
      }),
    ).rejects.toThrow("did not retain");
  });
});
