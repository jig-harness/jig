import { describe, expect, it } from "bun:test";
import { TrackerRequestError } from "../scripts/lib/tracker/port.ts";
import { GitHubApiError } from "../scripts/lib/tracker/github/transport.ts";
import {
  boardAnswer,
  conn,
  gitHub,
  issueNode,
  ON_BOARD,
  oneIssue,
  repoLabels,
  writes,
} from "./github-fixtures.ts";

const NOT_FOUND = new GitHubApiError("not found", {
  notFound: true,
  data: { repository: { issue: null } },
});

describe("GitHub adapter: reading an issue", () => {
  it("maps an open issue with state, priority and children onto the port", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op !== "TrackerIssue") throw new Error(`unexpected ${c.op}`);
      return oneIssue(
        issueNode({
          number: 12,
          title: "Fix login",
          body: "Steps",
          labels: ["bug", "In Progress", "priority: high"],
          assignee: "dana",
          milestone: "Q3",
          parent: 3,
          extra: {
            subIssues: conn([
              issueNode({ number: 13, labels: ["In Review"] }),
              issueNode({
                number: 14,
                state: "CLOSED",
                stateReason: "NOT_PLANNED",
              }),
            ]),
          },
        }),
      );
    });
    const issue = await t.getIssue("#12");
    expect(calls[0]?.variables).toEqual({
      owner: "acme",
      name: "app",
      number: 12,
    });
    expect(issue).toEqual({
      id: "I_12",
      identifier: "#12",
      title: "Fix login",
      description: "Steps",
      url: "https://github.com/acme/app/issues/12",
      updatedAt: "2026-01-02T00:00:00Z",
      state: { name: "In Progress", type: "started" },
      labels: ["bug"],
      parent: { identifier: "#3", title: "Issue 3" },
      children: [
        {
          identifier: "#13",
          title: "Issue 13",
          state: { name: "In Review", type: "started" },
          labels: [],
        },
        {
          identifier: "#14",
          title: "Issue 14",
          state: { name: "Canceled", type: "canceled" },
          labels: [],
        },
      ],
      assignee: "dana",
      project: "Q3",
    });
  });

  it("reads a bare number, a web address and another repository's key", async () => {
    const seen: unknown[] = [];
    const { t } = gitHub((c) => {
      seen.push(c.variables);
      return oneIssue(
        issueNode({
          number: c.variables.number as number,
          repo: `${c.variables.owner}/${c.variables.name}`,
          extra: { subIssues: conn([]) },
        }),
      );
    });
    expect((await t.getIssue("7"))?.identifier).toBe("#7");
    expect(
      (await t.getIssue("https://github.com/acme/app/issues/8"))?.identifier,
    ).toBe("#8");
    expect((await t.getIssue("other/lib#9"))?.identifier).toBe("other/lib#9");
    expect(seen).toEqual([
      { owner: "acme", name: "app", number: 7 },
      { owner: "acme", name: "app", number: 8 },
      { owner: "other", name: "lib", number: 9 },
    ]);
  });

  it("is null for an issue that does not exist, and refuses a key it cannot read", async () => {
    const { t } = gitHub(() => NOT_FOUND);
    expect(await t.getIssue("#404")).toBeNull();
    await expect(t.getIssue("ENG-1")).rejects.toThrow("not a GitHub issue key");
  });

  it("reads closed issues by close reason", async () => {
    const reasons: Array<[string | null, string]> = [
      ["COMPLETED", "completed"],
      [null, "completed"],
      ["NOT_PLANNED", "canceled"],
      ["DUPLICATE", "duplicate"],
    ];
    for (const [stateReason, type] of reasons) {
      const { t } = gitHub(() =>
        oneIssue(
          issueNode({
            number: 1,
            state: "CLOSED",
            stateReason,
            extra: { subIssues: conn([]) },
          }),
        ),
      );
      expect((await t.getIssue("#1"))?.state.type).toBe(type);
    }
  });

  it("reads the furthest-along state label, and an issue with none as todo", async () => {
    const { t } = gitHub((c) =>
      oneIssue(
        issueNode({
          number: c.variables.number as number,
          labels:
            c.variables.number === 1 ? ["In Progress", "in review"] : ["bug"],
          extra: { subIssues: conn([]) },
        }),
      ),
    );
    expect((await t.getIssue("#1"))?.state).toEqual({
      name: "In Review",
      type: "started",
    });
    expect((await t.getIssue("#2"))?.state).toEqual({
      name: "Todo",
      type: "unstarted",
    });
  });

  it("reads open states off the board in project mode", async () => {
    const { t, calls } = gitHub(
      (c) =>
        oneIssue(
          issueNode({
            number: c.variables.number as number,
            labels: ["In Progress"],
            status: c.variables.number === 1 ? "In Review" : undefined,
            extra: { subIssues: conn([]) },
          }),
        ),
      ON_BOARD,
    );
    expect((await t.getIssue("#1"))?.state.name).toBe("In Review");
    // A label named like a state is an ordinary label in project mode.
    const off = await t.getIssue("#2");
    expect(off?.state.name).toBe("Todo");
    expect(off?.labels).toEqual(["In Progress"]);
    expect(calls[0]?.query).toContain('fieldValueByName(name: "Status")');
  });

  it("refuses a board option that names no open state", async () => {
    const { t } = gitHub(
      (c) =>
        oneIssue(
          issueNode({
            number: c.variables.number as number,
            status: "Awaiting approval",
            extra: { subIssues: conn([]) },
          }),
        ),
      ON_BOARD,
    );
    await expect(t.getIssue("#1")).rejects.toThrow(
      "the Status option 'Awaiting approval' names no open state",
    );
  });

  it("refuses a child list longer than one page", async () => {
    const { t } = gitHub(() =>
      oneIssue(issueNode({ number: 1, extra: { subIssues: conn([], "c1") } })),
    );
    await expect(t.getIssue("#1")).rejects.toThrow("partial");
  });

  it("marks comments trusted only from people who can write to the repository", async () => {
    const { t } = gitHub(() => ({
      repository: {
        issue: {
          id: "I_1",
          comments: conn([
            {
              id: "C2",
              body: "later",
              createdAt: "2026-02-02T00:00:00Z",
              authorAssociation: "NONE",
            },
            {
              id: "C1",
              body: "first",
              createdAt: "2026-02-01T00:00:00Z",
              authorAssociation: "MEMBER",
            },
          ]),
        },
      },
    }));
    expect(await t.listComments("#1")).toEqual([
      { body: "first", createdAt: "2026-02-01T00:00:00Z" },
      { body: "later", createdAt: "2026-02-02T00:00:00Z" },
    ]);
    const facts = await t.issueComments("#1");
    expect(facts.uuid).toBe("I_1");
    expect(facts.comments.map((c) => c.trusted)).toEqual([false, true]);
  });
});

describe("GitHub adapter: moving an issue between states", () => {
  const issueWith = (
    labels: string[],
    state: "OPEN" | "CLOSED" = "OPEN",
    stateReason: string | null = null,
  ) => oneIssue(issueNode({ number: 5, labels, state, stateReason }));

  it("swaps state labels for an open state", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerIssue") return issueWith(["bug", "In Progress"]);
      if (c.op === "TrackerLabels")
        return repoLabels("bug", "In Progress", "In Review");
      return {};
    });
    await t.transition("#5", "in_review");
    expect(writes(calls)).toEqual(["TrackerAddLabels", "TrackerRemoveLabels"]);
    expect(
      calls.find((c) => c.op === "TrackerAddLabels")?.variables.labelIds,
    ).toEqual(["LA_2_In Review"]);
    expect(
      calls.find((c) => c.op === "TrackerRemoveLabels")?.variables.labelIds,
    ).toEqual(["LA_1_In Progress"]);
  });

  it("removes every state label for todo, and reopens a closed issue", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerIssue")
        return issueWith(["In Review"], "CLOSED", "COMPLETED");
      if (c.op === "TrackerLabels") return repoLabels("In Review");
      return {};
    });
    await t.transition("#5", "todo");
    expect(writes(calls)).toEqual(["TrackerReopen", "TrackerRemoveLabels"]);
  });

  it("closes with the state's reason and drops its state labels", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerIssue") return issueWith(["In Progress"]);
      if (c.op === "TrackerLabels") return repoLabels("In Progress");
      return {};
    });
    await t.transition("#5", "canceled");
    expect(writes(calls)).toEqual(["TrackerClose", "TrackerRemoveLabels"]);
    expect(
      calls.find((c) => c.op === "TrackerClose")?.variables.stateReason,
    ).toBe("NOT_PLANNED");
  });

  it("refuses a state label the repository lacks before writing, naming how to create it", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerIssue") return issueWith([]);
      if (c.op === "TrackerLabels") return repoLabels("bug");
      return {};
    });
    const err = await t
      .transition("#5", "in_progress")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackerRequestError);
    expect(String(err)).toContain(
      "issue_tracker.states.in_progress names 'In Progress'",
    );
    expect(String(err)).toContain(
      'gh label create "In Progress" --repo acme/app',
    );
    expect(writes(calls)).toEqual([]);
  });

  it("adds the issue to the board and sets its option in project mode", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerIssue") return issueWith([]);
      if (c.op === "TrackerBoard")
        return boardAnswer("Todo", "In Progress", "Done");
      if (c.op === "TrackerAddItem")
        return { addProjectV2ItemById: { item: { id: "PVTI_new" } } };
      return {};
    }, ON_BOARD);
    await t.transition("#5", "in_progress");
    expect(writes(calls)).toEqual(["TrackerAddItem", "TrackerSetStatus"]);
    expect(calls.find((c) => c.op === "TrackerSetStatus")?.variables).toEqual({
      projectId: "PVT_7",
      itemId: "PVTI_new",
      fieldId: "PVTSSF_status",
      optionId: "opt_1",
    });
  });

  it("closes without an option when the board has none for the closed state", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerIssue")
        return oneIssue(issueNode({ number: 5, status: "Todo" }));
      if (c.op === "TrackerBoard") return boardAnswer("Todo", "Done");
      return {};
    }, ON_BOARD);
    await t.transition("#5", "duplicate");
    expect(writes(calls)).toEqual(["TrackerClose"]);
  });

  it("refuses an open state the board has no option for", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerIssue") return issueWith([]);
      if (c.op === "TrackerBoard") return boardAnswer("Todo", "Done");
      return {};
    }, ON_BOARD);
    await expect(t.transition("#5", "in_review")).rejects.toThrow(
      "matches 0 options",
    );
    expect(writes(calls)).toEqual([]);
  });
});

describe("GitHub adapter: filing and planning", () => {
  it("files an issue with its labels, priority label, parent and milestone", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerRepository") return { repository: { id: "R_1" } };
      if (c.op === "TrackerLabels") return repoLabels("bug", "priority: high");
      if (c.op === "TrackerIssue") return oneIssue(issueNode({ number: 3 }));
      if (c.op === "TrackerMilestones")
        return {
          repository: {
            milestones: conn([{ id: "MI_1", number: 2, title: "Q3" }]),
          },
        };
      if (c.op === "TrackerCreate")
        return {
          createIssue: {
            issue: { number: 40, url: "https://github.com/acme/app/issues/40" },
          },
        };
      throw new Error(`unexpected ${c.op}`);
    });
    const out = await t.createIssue({
      title: "New",
      description: "Body",
      labels: ["Bug"],
      priority: 2,
      parent: "#3",
      project: "Q3",
    });
    expect(out).toEqual({
      identifier: "#40",
      url: "https://github.com/acme/app/issues/40",
    });
    expect(
      calls.find((c) => c.op === "TrackerCreate")?.variables.input,
    ).toEqual({
      repositoryId: "R_1",
      title: "New",
      body: "Body",
      labelIds: ["LA_0_bug", "LA_1_priority: high"],
      parentIssueId: "I_3",
      milestoneId: "MI_1",
    });
  });

  it("refuses an unknown label, a state label and a bad priority before writing", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerLabels") return repoLabels("bug");
      return {};
    });
    await expect(
      t.createIssue({ title: "x", description: "", labels: ["nope"] }),
    ).rejects.toThrow("'nope' matches no label");
    await expect(
      t.createIssue({ title: "x", description: "", labels: ["In Review"] }),
    ).rejects.toThrow("workflow state or a priority");
    await expect(
      t.createIssue({ title: "x", description: "", labels: [], priority: 9 }),
    ).rejects.toThrow("priority must be an integer");
    expect(writes(calls)).toEqual([]);
  });

  it("changes priority by swapping labels, and moves the parent", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerIssue") {
        const n = c.variables.number as number;
        return oneIssue(
          issueNode({
            number: n,
            labels: n === 5 ? ["priority: low", "bug"] : [],
            parent: n === 5 ? 1 : null,
          }),
        );
      }
      if (c.op === "TrackerLabels")
        return repoLabels("bug", "priority: urgent", "priority: low");
      return {};
    });
    await t.updateIssue("#5", { priority: 1, parent: "#2", title: "Renamed" });
    expect(writes(calls)).toEqual([
      "TrackerUpdate",
      "TrackerAddLabels",
      "TrackerRemoveLabels",
      "TrackerAddSubIssue",
    ]);
    expect(
      calls.find((c) => c.op === "TrackerAddLabels")?.variables.labelIds,
    ).toEqual(["LA_1_priority: urgent"]);
    expect(
      calls.find((c) => c.op === "TrackerRemoveLabels")?.variables.labelIds,
    ).toEqual(["LA_2_priority: low"]);
    expect(calls.find((c) => c.op === "TrackerAddSubIssue")?.variables).toEqual(
      { issueId: "I_2", subIssueId: "I_5" },
    );
  });

  it("refuses a patch that adds and removes one label under two spellings", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerIssue")
        return oneIssue(issueNode({ number: 5, labels: ["bug"] }));
      if (c.op === "TrackerLabels") return repoLabels("bug");
      return {};
    });
    await expect(
      t.updateIssue("#5", { addLabels: ["Bug"], removeLabels: ["bug"] }),
    ).rejects.toThrow("both adds and removes 'Bug'");
    expect(writes(calls)).toEqual([]);
  });

  it("removes the parent when the patch clears it", async () => {
    const { t, calls } = gitHub((c) =>
      oneIssue(
        issueNode({
          number: c.variables.number as number,
          parent: c.variables.number === 5 ? 1 : null,
        }),
      ),
    );
    await t.updateIssue("#5", { parent: null });
    expect(writes(calls)).toEqual(["TrackerRemoveSubIssue"]);
    expect(calls.at(-1)?.variables).toEqual({
      issueId: "I_1",
      subIssueId: "I_5",
    });
  });

  it("lists the repository's labels without the state and priority labels", async () => {
    const { t } = gitHub(() =>
      repoLabels("bug", "In Progress", "priority: high", "epic"),
    );
    expect(await t.listLabels()).toEqual([
      { name: "bug", group: null },
      { name: "epic", group: null },
    ]);
  });

  it("searches the repository as a phrase and refuses a result it cannot return in full", async () => {
    const answer = (count: number) => ({
      search: {
        issueCount: count,
        ...conn([issueNode({ number: 2, title: "Login fails" })]),
      },
    });
    const { t, calls } = gitHub(() => answer(1));
    expect(
      (await t.searchIssues('login "fails')).map((i) => i.identifier),
    ).toEqual(["#2"]);
    expect(calls[0]?.variables.q).toBe(
      'repo:acme/app is:issue is:open in:title,body "login  fails"',
    );
    const capped = gitHub(() => answer(1500));
    await expect(capped.t.searchIssues("login")).rejects.toThrow(
      "more than a search can return",
    );
  });
});

describe("GitHub adapter: relations", () => {
  const ref = (n: number, repo = "acme/app") => ({
    number: n,
    repository: { nameWithOwner: repo },
  });

  it("reads blockers, duplicates in both directions and related markers by trusted authors", async () => {
    const { t } = gitHub((c) => {
      if (c.op === "TrackerIssue")
        return oneIssue(
          issueNode({
            number: 5,
            extra: {
              blockedBy: conn([ref(1)]),
              blocking: conn([ref(9, "other/lib")]),
              duplicateOf: ref(4),
              timelineItems: conn([
                {
                  canonical: ref(5),
                  duplicate: { ...ref(6), duplicateOf: ref(5) },
                },
                // Unmarked since: the duplicate no longer points here.
                {
                  canonical: ref(5),
                  duplicate: { ...ref(7), duplicateOf: null },
                },
              ]),
            },
          }),
        );
      return {
        repository: {
          issue: {
            id: "I_5",
            comments: conn([
              {
                id: "C1",
                body: "<!-- jig:related acme/app#8 -->\nRelated to acme/app#8.",
                createdAt: "2026-01-01T00:00:00Z",
                authorAssociation: "COLLABORATOR",
              },
              {
                id: "C2",
                body: "<!-- jig:related acme/app#99 -->",
                createdAt: "2026-01-01T00:00:00Z",
                authorAssociation: "NONE",
              },
            ]),
          },
        },
      };
    });
    expect(await t.listRelations("#5")).toEqual([
      { type: "blocked_by", issue: "#1" },
      { type: "blocks", issue: "other/lib#9" },
      { type: "duplicate", issue: "#4" },
      { type: "duplicated_by", issue: "#6" },
      { type: "related", issue: "#8" },
    ]);
  });

  it("records blocks as a dependency of the target and duplicate as a close", async () => {
    const { t, calls } = gitHub((c) =>
      oneIssue(issueNode({ number: c.variables.number as number })),
    );
    await t.relate("#1", "blocks", "#2");
    await t.relate("#3", "duplicate", "#4");
    expect(writes(calls)).toEqual(["TrackerAddBlockedBy", "TrackerClose"]);
    expect(
      calls.find((c) => c.op === "TrackerAddBlockedBy")?.variables,
    ).toEqual({ issueId: "I_2", blockingIssueId: "I_1" });
    expect(calls.find((c) => c.op === "TrackerClose")?.variables).toEqual({
      issueId: "I_3",
      stateReason: "DUPLICATE",
      duplicateIssueId: "I_4",
    });
  });

  /** An adapter whose issues keep the comments written to them. */
  function commenting(notes: Record<number, string[]>) {
    return gitHub((c) => {
      if (c.op === "TrackerIssue")
        return oneIssue(
          issueNode({
            number: c.variables.number as number,
            extra: {
              blockedBy: conn([]),
              blocking: conn([]),
              duplicateOf: null,
              timelineItems: conn([]),
            },
          }),
        );
      if (c.op === "TrackerComments") {
        const n = c.variables.number as number;
        return {
          repository: {
            issue: {
              id: `I_${n}`,
              comments: conn(
                (notes[n] ?? []).map((body, i) => ({
                  id: `C_${n}_${i}`,
                  body,
                  createdAt: "2026-01-01T00:00:00Z",
                  authorAssociation: "OWNER",
                })),
              ),
            },
          },
        };
      }
      if (c.op === "TrackerComment") {
        const n = Number(String(c.variables.subjectId).slice(2));
        notes[n] = [...(notes[n] ?? []), String(c.variables.body)];
      }
      return {};
    });
  }
  const commentedOn = (
    calls: { op: string; variables: Record<string, unknown> }[],
  ) =>
    calls
      .filter((c) => c.op === "TrackerComment")
      .map((c) => c.variables.subjectId);

  it("records related as a marked comment on each side, once", async () => {
    const { t, calls } = commenting({});
    await t.relate("#1", "related", "#2");
    expect(commentedOn(calls)).toEqual(["I_1", "I_2"]);
    expect(
      calls.find((c) => c.op === "TrackerComment")?.variables.body,
    ).toContain("<!-- jig:related acme/app#2 -->");
    await t.relate("#1", "related", "#2");
    expect(commentedOn(calls)).toEqual(["I_1", "I_2"]);
  });

  it("writes only the missing side of a half-written related link", async () => {
    const { t, calls } = commenting({ 1: ["<!-- jig:related acme/app#2 -->"] });
    await t.relate("#1", "related", "#2");
    expect(commentedOn(calls)).toEqual(["I_2"]);
  });

  it("refuses an issue related to itself", async () => {
    const { t, calls } = gitHub(() => ({}));
    await expect(t.relate("#1", "blocks", "#1")).rejects.toThrow(
      "related to itself",
    );
    expect(calls).toEqual([]);
  });

  it("refuses an issue related to itself under another spelling of its key", async () => {
    const { t, calls } = gitHub((c) =>
      oneIssue(issueNode({ number: c.variables.number as number })),
    );
    for (const type of ["related", "blocks", "duplicate"] as const)
      await expect(t.relate("#1", type, "1")).rejects.toThrow(
        "related to itself",
      );
    expect(writes(calls)).toEqual([]);
  });
});

describe("GitHub adapter: reading in pages and refusing what it cannot do", () => {
  it("reads every page of a listing, passing each cursor on", async () => {
    const { t, calls } = gitHub((c) => {
      const page =
        c.variables.after === null
          ? conn([issueNode({ number: 2 })], "c1")
          : conn([issueNode({ number: 3 })]);
      return { repository: { issue: { subIssues: page } } };
    });
    expect((await t.listChildren("#1")).map((i) => i.identifier)).toEqual([
      "#2",
      "#3",
    ]);
    expect(calls.map((c) => c.variables.after)).toEqual([null, "c1"]);
  });

  it("refuses a listing that repeats an issue across pages", async () => {
    const { t } = gitHub((c) => ({
      repository: {
        issue: {
          subIssues:
            c.variables.after === null
              ? conn([issueNode({ number: 2 })], "c1")
              : conn([issueNode({ number: 2 })]),
        },
      },
    }));
    await expect(t.listChildren("#1")).rejects.toThrow("repeated across pages");
  });

  it("refuses label and milestone changes on another repository's issue before reading it", async () => {
    const { t, calls } = gitHub(() => ({}));
    await expect(t.transition("other/lib#3", "done")).rejects.toThrow(
      "issue of other/lib",
    );
    await expect(
      t.updateIssue("other/lib#3", { addLabels: ["bug"] }),
    ).rejects.toThrow("issue of other/lib");
    expect(calls).toEqual([]);
  });

  it("reports a repository it cannot see rather than an absent issue", async () => {
    const { t } = gitHub(
      () =>
        new GitHubApiError("no repository", {
          notFound: true,
          data: { repository: null },
        }),
    );
    await expect(t.getIssue("#1")).rejects.toThrow("no repository");
  });

  it("names the board setting when the board does not resolve", async () => {
    const { t, calls } = gitHub((c) => {
      if (c.op === "TrackerIssue") return oneIssue(issueNode({ number: 5 }));
      return new GitHubApiError("no board", {
        notFound: true,
        data: { organization: { projectV2: null } },
      });
    }, ON_BOARD);
    await expect(t.transition("#5", "in_progress")).rejects.toThrow(
      "gh auth refresh -s project",
    );
    expect(writes(calls)).toEqual([]);
  });
});
