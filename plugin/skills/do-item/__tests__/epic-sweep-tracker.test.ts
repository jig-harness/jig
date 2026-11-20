import { describe, expect, test } from "bun:test";
import {
  listSweepEpics,
  prepareSweepTracker,
  readSweepReply,
  validateSweepRemainder,
} from "../scripts/lib/epic-sweep-tracker.ts";
import type {
  CommentFact,
  CanonicalState,
  Issue,
  IssueRelation,
} from "../scripts/lib/tracker/port.ts";

const repo = "https://github.com/example/project";
const replyUrl = `${repo}/issues/1#issuecomment-2`;
const done = { name: "Done", type: "completed" };
const open = { name: "Backlog", type: "backlog" };

function issue(key: string, fields: Partial<Issue> = {}): Issue {
  return {
    id: `id-${key}`,
    identifier: key,
    title: key,
    url: `${repo}/issues/${key.slice(1)}`,
    state: open,
    description: "",
    labels: [],
    nativeType: null,
    isEpic: false,
    parent: null,
    children: [],
    assignee: null,
    project: null,
    priority: 0,
    type: null,
    size: null,
    ...fields,
  };
}

function fact(body: string, fields: Partial<CommentFact> = {}): CommentFact {
  return {
    body,
    createdAt: "2026-01-02T00:00:00Z",
    author: { id: "person", name: "person" },
    trusted: true,
    ...fields,
  };
}

function fixture() {
  const epic = issue("#1", { isEpic: true, nativeType: "Epic" });
  const destination = issue("#2");
  const tail = issue("#3", { parent: { identifier: epic.identifier } });
  const backlog = issue("#4", { title: "Finish the approved remainder" });
  epic.children = [tail];
  const byKey = new Map(
    [epic, destination, tail, backlog].map((item) => [item.identifier, item]),
  );
  const actions: string[] = [];
  const notes = new Map<string, CommentFact[]>();
  const relations = new Map<string, IssueRelation[]>();
  const tracker = {
    adapter: "github",
    team: "example/project",
    async getIssue(key: string) {
      return byKey.get(key) ?? null;
    },
    async labelledIssues(label: string) {
      expect(label).toBe("epic");
      return [
        {
          identifier: epic.identifier,
          stateType: "started",
          completedAt: null,
        },
        { identifier: "#5", stateType: "completed", completedAt: null },
      ];
    },
    async issueComments(key: string) {
      return { uuid: key, comments: notes.get(key) ?? [] };
    },
    async postComment(key: string, body: string) {
      actions.push(`comment ${key}`);
      notes.set(key, [...(notes.get(key) ?? []), fact(body)]);
    },
    async listRelations(key: string) {
      return relations.get(key) ?? [];
    },
    async relate(key: string, type: "related", target: string) {
      actions.push(`link ${key} ${target}`);
      relations.set(key, [
        ...(relations.get(key) ?? []),
        { type, issue: target },
      ]);
    },
    async updateIssue(key: string, patch: { parent?: string | null }) {
      actions.push(`parent ${key} ${patch.parent}`);
      tail.parent = patch.parent ? { identifier: patch.parent } : null;
      epic.children = [];
    },
    async transition(key: string, state: CanonicalState) {
      actions.push(`state ${key} ${state}`);
      if (key === epic.identifier) epic.state = done;
      if (key === tail.identifier && state === "backlog") tail.state = open;
    },
    stateName(state: CanonicalState) {
      return state === "done" ? "Done" : "Backlog";
    },
  };
  return { tracker, epic, tail, actions, notes, relations };
}

describe("sweep tracker integration", () => {
  test("lists open epics through the tracker’s type-aware listing without writing", async () => {
    const { tracker, actions } = fixture();
    expect(await listSweepEpics(tracker, "epic")).toEqual(["#1"]);
    expect(actions).toEqual([]);
  });

  test("acceptance prepares without writing, records the check, moves it and closes", async () => {
    const { tracker, epic, tail, actions, notes } = fixture();
    const run = await prepareSweepTracker(tracker, {
      epic,
      personChecks: "#2",
      personTails: ["#3"],
      ordinaryTails: [],
      operatorSteps: ["Verify the rollout"],
      replyUrl,
    });
    expect(actions).toEqual([]);
    await run();
    expect(actions).toEqual([
      "comment #2",
      "link #3 #1",
      "comment #3",
      "parent #3 #2",
      "comment #1",
      "state #1 done",
    ]);
    expect(tail.parent).toEqual({ identifier: "#2" });
    expect(notes.get("#1")?.[0]?.body).toContain(replyUrl);
    expect(notes.get("#1")?.[0]?.body).toEndWith("<!-- jig:epic-waiver -->");
  });

  test("moves ordinary tails to backlog before closing the epic", async () => {
    const { tracker, epic, tail, actions } = fixture();
    tail.state = { name: "In Progress", type: "started" };
    await (
      await prepareSweepTracker(tracker, {
        epic,
        personTails: [],
        ordinaryTails: ["#3"],
        operatorSteps: [],
        replyUrl,
      })
    )();
    expect(actions).toEqual([
      "link #3 #1",
      "comment #3",
      "parent #3 null",
      "state #3 backlog",
      "comment #1",
      "state #1 done",
    ]);
    expect(tail.parent).toBeNull();
    expect(tail.state).toEqual(open);
  });

  test("missing person-checks configuration stops before writes", async () => {
    const { tracker, epic, actions } = fixture();
    await expect(
      prepareSweepTracker(tracker, {
        epic,
        personTails: ["#3"],
        ordinaryTails: [],
        operatorSteps: [],
        replyUrl,
      }),
    ).rejects.toThrow("issue_tracker.person_checks");
    expect(actions).toEqual([]);
  });

  test("an epic that holds the standing list is kept open", async () => {
    const { tracker, epic, actions } = fixture();
    await expect(
      prepareSweepTracker(tracker, {
        epic,
        personChecks: "#1",
        personTails: [],
        ordinaryTails: [],
        operatorSteps: [],
        replyUrl,
      }),
    ).rejects.toThrow("standing issue_tracker.person_checks");
    expect(actions).toEqual([]);
  });

  test("a new epic label prevents applying the prepared sweep", async () => {
    const { tracker, epic, actions } = fixture();
    const apply = await prepareSweepTracker(tracker, {
      epic: { ...epic },
      personChecks: "#2",
      personTails: ["#3"],
      ordinaryTails: [],
      operatorSteps: [],
      replyUrl,
    });
    epic.labels = ["manual-ops"];
    await expect(apply()).rejects.toThrow("changed since");
    expect(actions).toEqual([]);
  });

  test("retry after moving the check closes once with its existing provenance", async () => {
    const { tracker, epic, actions } = fixture();
    const input = {
      epic,
      personChecks: "#2",
      personTails: ["#3"],
      ordinaryTails: [],
      operatorSteps: [],
      replyUrl,
    };
    const transition = tracker.transition;
    tracker.transition = async () => {
      throw new Error("transition timed out");
    };
    await expect((await prepareSweepTracker(tracker, input))()).rejects.toThrow(
      "transition timed out",
    );
    tracker.transition = transition;
    await (await prepareSweepTracker(tracker, input))();
    expect(actions).toEqual([
      "link #3 #1",
      "comment #3",
      "parent #3 #2",
      "comment #1",
      "state #1 done",
    ]);
  });

  test("retry after a failed move reuses the link and comment", async () => {
    const { tracker, epic, actions } = fixture();
    const input = {
      epic,
      personChecks: "#2",
      personTails: ["#3"],
      ordinaryTails: [],
      operatorSteps: [],
      replyUrl,
    };
    const update = tracker.updateIssue;
    tracker.updateIssue = async () => {
      throw new Error("parent update timed out");
    };
    await expect((await prepareSweepTracker(tracker, input))()).rejects.toThrow(
      "parent update timed out",
    );
    tracker.updateIssue = update;
    await (await prepareSweepTracker(tracker, input))();
    expect(actions).toEqual([
      "link #3 #1",
      "comment #3",
      "parent #3 #2",
      "comment #1",
      "state #1 done",
    ]);
  });

  test("the acceptance reply must be trusted and follow the proposal", async () => {
    const { tracker, notes } = fixture();
    const marker = `<!-- jig:epic-sweep ${"a".repeat(64)} -->`;
    const proposed = fact(marker, { createdAt: "2026-01-01T00:00:00Z" });
    const accepted = fact("accept all", {
      url: replyUrl,
      createdAt: "2026-01-02T00:00:00Z",
      editedAt: "2026-01-04T00:00:00Z",
    });
    notes.set("#1", [proposed, accepted]);
    expect(await readSweepReply(tracker, replyUrl)).toEqual({
      body: "accept all",
      precedingBodies: [marker],
    });
    const later = `<!-- jig:epic-sweep ${"b".repeat(64)} -->`;
    notes.set("#1", [
      proposed,
      accepted,
      fact(later, {
        createdAt: "2026-01-03T00:00:00Z",
      }),
    ]);
    expect(await readSweepReply(tracker, replyUrl)).toEqual({
      body: "accept all",
      precedingBodies: [marker, later],
    });
    notes.set("#1", [
      proposed,
      accepted,
      fact(marker, {
        createdAt: "2026-01-03T00:00:00Z",
        editedAt: "2026-01-05T00:00:00Z",
      }),
    ]);
    await expect(readSweepReply(tracker, replyUrl)).rejects.toThrow(
      "Proposal changed after the reply",
    );
    notes.set("#1", [
      proposed,
      accepted,
      fact(marker, { createdAt: "unreadable" }),
    ]);
    await expect(readSweepReply(tracker, replyUrl)).rejects.toThrow(
      "proposal's time",
    );
    await expect(
      readSweepReply(tracker, replyUrl.replace("/example/", "/other/")),
    ).rejects.toThrow("comment URL");
    notes.set("#1", [fact("accept all", { trusted: false, url: replyUrl })]);
    await expect(readSweepReply(tracker, replyUrl)).rejects.toThrow("trusted");
  });

  test("a remainder must already exist in backlog and link to the epic", async () => {
    const { tracker, epic, relations, actions } = fixture();
    const remainder = [{ issue: "#4", title: "Finish the approved remainder" }];
    await expect(
      validateSweepRemainder(tracker, epic, remainder),
    ).rejects.toThrow("related");
    relations.set("#4", [{ type: "related", issue: "#1" }]);
    await expect(
      validateSweepRemainder(tracker, epic, [
        {
          issue: "#4",
          title: "A different remainder",
        },
      ]),
    ).rejects.toThrow("title");
    await validateSweepRemainder(tracker, epic, remainder);
    expect(actions).toEqual([]);
  });
});
