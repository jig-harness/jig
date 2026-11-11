/**
 * Assigning an unassigned issue on Linear and Jira, which hold one assignee
 * and offer no conditional write: the adapter assigns, then reads the
 * issue's history to verify the assignment replaced nobody, putting back
 * anyone it did replace. The rule, then each adapter over its fake
 * transport.
 */
import { describe, expect, it } from "bun:test";
import {
  type AssigneeChange,
  checkAssignment,
} from "../scripts/lib/tracker/assign-verified.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";
import { type Call, FACTORY, issue, jira, MEMBER } from "./jira-fixtures.ts";

const at = (s: number) =>
  new Date(Date.UTC(2026, 10, 1, 0, 0, s)).toISOString();

describe("checkAssignment", () => {
  it("accepts a newest change to the user that came from nobody", () => {
    const changes: AssigneeChange[] = [
      { from: null, to: "x", at: at(1) },
      { from: "x", to: null, at: at(2) },
      { from: null, to: "me", at: at(3) },
    ];
    expect(checkAssignment("me", changes, "me")).toEqual({ ok: true });
  });

  it("names the assignee a newest change from someone replaced", () => {
    const changes: AssigneeChange[] = [
      { from: null, to: "dana", at: at(1) },
      { from: "dana", to: "me", at: at(2) },
    ];
    expect(checkAssignment("me", changes, "me")).toEqual({
      ok: false,
      replaced: "dana",
    });
  });

  it("ignores an older assignment of the same account when the write left no change of its own", () => {
    const changes: AssigneeChange[] = [
      { from: null, to: "me", at: at(1) },
      { from: "me", to: null, at: at(2) },
    ];
    expect(checkAssignment("me", changes, "me", changes)).toEqual({
      ok: false,
      replaced: null,
    });
    expect(
      checkAssignment(
        "me",
        [...changes, { from: null, to: "me", at: at(3) }],
        "me",
        changes,
      ),
    ).toEqual({ ok: true });
  });

  it("does not mistake a tied-time older change for the write's evidence", () => {
    const old: AssigneeChange[] = [
      { from: "me", to: null, at: at(1) },
      { from: null, to: "me", at: at(1) },
    ];
    const listing: AssigneeChange[] = [
      { from: "dana", to: "me", at: at(1) },
      ...old,
    ];
    expect(checkAssignment("me", listing, "me", old)).toEqual({
      ok: false,
      replaced: "dana",
    });
  });

  it("fails closed when a delayed older sequence becomes visible while a racing change stays hidden", () => {
    const changes: AssigneeChange[] = [
      { from: null, to: "me", at: at(1) },
      { from: "me", to: null, at: at(2) },
    ];
    expect(checkAssignment("me", changes, "me", [])).toEqual({
      ok: false,
      replaced: null,
    });
  });

  it("fails closed when the new changes skip one the tracker has not shown", () => {
    const changes: AssigneeChange[] = [
      { from: null, to: "dana", at: at(1) },
      { from: "erin", to: "me", at: at(2) },
    ];
    expect(checkAssignment("me", changes, "me", [])).toEqual({
      ok: false,
      replaced: null,
    });
  });

  it("refuses, restoring nobody, when the issue is no longer the user's or the history holds no change to it", () => {
    expect(checkAssignment("dana", [], "me")).toEqual({
      ok: false,
      replaced: null,
    });
    expect(checkAssignment("me", [], "me")).toEqual({
      ok: false,
      replaced: null,
    });
  });
});

const ME = { id: "u-me", name: "dana" };
const OTHER = { id: "u-other", name: "other" };

/** Linear issue ENG-4 whose assignee and history the fake keeps; `race` assigns OTHER just before the claim's write. */
function linearWorld(
  options: {
    assignee?: string | null;
    race?: boolean;
    noHistory?: boolean;
  } = {},
) {
  let assignee: string | null = options.assignee ?? null;
  const history: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  let tick = 0;
  const change = (to: string | null) => {
    tick++;
    if (!options.noHistory)
      history.push({
        id: `h${tick}`,
        createdAt: at(tick),
        fromAssignee: assignee === null ? null : { id: assignee },
        toAssignee: to === null ? null : { id: to },
      });
    assignee = to;
  };
  const transport: LinearTransport = async (query, variables) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    switch (op) {
      case "TrackerAssignee":
        return {
          issue: {
            id: "uuid-4",
            assignee:
              assignee === null ? null : { id: assignee, name: assignee },
          },
        };
      case "TrackerAssign": {
        const to = (variables.input as { assigneeId: string }).assigneeId;
        writes.push(to);
        if (options.race && writes.length === 1) change(OTHER.id);
        change(to);
        return { issueUpdate: { success: true } };
      }
      case "TrackerAssigneeHistory":
        return {
          issue: {
            history: { pageInfo: { hasNextPage: false }, nodes: history },
          },
        };
      default:
        throw new Error(`unexpected ${op}`);
    }
  };
  const t = linearTracker({
    team: "ENG",
    states: parseTrackerConfig({}).states,
    transport,
  });
  return { t, writes, now: () => assignee };
}

describe("Linear: assigning an unassigned issue", () => {
  it("assigns, and verifies the assignment came from nobody", async () => {
    const w = linearWorld();
    expect(await w.t.assignUnassigned?.("ENG-4", ME)).toBe(true);
    expect(w.writes).toEqual([ME.id]);
    expect(w.now()).toBe(ME.id);
  });

  it("writes nothing to an issue someone already holds", async () => {
    const w = linearWorld({ assignee: OTHER.id });
    expect(await w.t.assignUnassigned?.("ENG-4", ME)).toBe(false);
    expect(w.writes).toEqual([]);
  });

  it("puts back an assignee its write replaced, and refuses", async () => {
    const w = linearWorld({ race: true });
    expect(await w.t.assignUnassigned?.("ENG-4", ME)).toBe(false);
    expect(w.writes).toEqual([ME.id, OTHER.id]);
    expect(w.now()).toBe(OTHER.id);
  });

  it("refuses, restoring nobody, when the history cannot verify the write", async () => {
    const w = linearWorld({ noHistory: true });
    expect(await w.t.assignUnassigned?.("ENG-4", ME)).toBe(false);
    expect(w.writes).toEqual([ME.id]);
  });
});

/** Jira issue ENG-1 whose assignee and changelog the fake keeps; `race` assigns MEMBER just before the claim's write. */
function jiraWorld(
  options: {
    assignee?: string | null;
    race?: boolean;
    incomplete?: boolean;
  } = {},
) {
  let assignee: string | null = options.assignee ?? null;
  const changelog: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  const account = (id: string | null) =>
    id === null
      ? null
      : id === MEMBER.accountId
        ? MEMBER
        : { ...FACTORY, accountId: id };
  const change = (to: string | null) => {
    changelog.push({
      id: String(changelog.length + 1),
      created: at(changelog.length + 1),
      author: FACTORY,
      items: [
        options.incomplete
          ? { fieldId: "assignee", to }
          : { fieldId: "assignee", from: assignee, to },
      ],
    });
    assignee = to;
  };
  const { t } = jira((c: Call) => {
    if (c.route === "GET issue/ENG-1")
      return issue({ key: "ENG-1", assignee: account(assignee) });
    if (c.route === "PUT issue/ENG-1/assignee") {
      const to = String(c.body.accountId);
      writes.push(to);
      if (options.race && writes.length === 1) change(MEMBER.accountId);
      change(to);
      return null;
    }
    if (c.route === "GET issue/ENG-1/changelog")
      return {
        values: changelog,
        startAt: 0,
        maxResults: 100,
        total: changelog.length,
      };
    return new Error(`unexpected request ${c.route}`);
  });
  return { t, writes, now: () => assignee };
}

describe("Jira: assigning an unassigned issue", () => {
  const me = { id: FACTORY.accountId, name: FACTORY.displayName };

  it("assigns, and verifies the assignment came from nobody", async () => {
    const w = jiraWorld();
    expect(await w.t.assignUnassigned?.("ENG-1", me)).toBe(true);
    expect(w.writes).toEqual([me.id]);
  });

  it("writes nothing to an issue someone already holds", async () => {
    const w = jiraWorld({ assignee: MEMBER.accountId });
    expect(await w.t.assignUnassigned?.("ENG-1", me)).toBe(false);
    expect(w.writes).toEqual([]);
  });

  it("refuses to verify from a changelog item that omits its from side", async () => {
    const w = jiraWorld({ incomplete: true });
    await expect(w.t.assignUnassigned?.("ENG-1", me)).rejects.toThrow(
      /omits a side/,
    );
  });

  it("puts back an assignee its write replaced, and refuses", async () => {
    const w = jiraWorld({ race: true });
    expect(await w.t.assignUnassigned?.("ENG-1", me)).toBe(false);
    expect(w.writes).toEqual([me.id, MEMBER.accountId]);
    expect(w.now()).toBe(MEMBER.accountId);
  });
});
