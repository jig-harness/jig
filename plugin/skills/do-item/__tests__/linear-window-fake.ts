/**
 * A fake Linear workspace holding one issue, ENG-1, created at `T0`, whose
 * history, like Linear's, records an assignment only when it is written
 * three minutes or more after the issue's creation; and a clock a test
 * moves, whose `sleep` moves it on.
 */
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";

/** Linear's three minutes, written here on purpose: not the adapter's own constant. */
const WINDOW_MS = 3 * 60_000;
export const T0 = Date.parse("2026-11-20T12:00:00.000Z");
export const iso = (ms: number) => new Date(ms).toISOString();
export const FACTORY = "factory@example.com";
const LEAD = {
  id: "lead",
  name: "lead",
  guest: false,
  teams: { nodes: [{ key: "ENG" }] },
};

/** A clock the test moves: `sleep` moves it on and records the wait. */
export function fakeClock(start: number) {
  const clock = {
    ms: start,
    waits: [] as number[],
    now: () => clock.ms,
    sleep: async (ms: number) => {
      clock.waits.push(ms);
      clock.ms += ms;
    },
  };
  return clock;
}

export interface Entry {
  createdAt: string;
  toAssignee: string;
  /** Made by a guest of the team, who may not start work; by the lead when absent. */
  byGuest?: boolean;
}

/** The fake workspace, read and written through the Linear adapter. */
export function fakeLinear(
  clock: { now(): number },
  start: { assignee?: string | null; history?: Entry[] } = {},
) {
  const issue = {
    assignee: start.assignee ?? null,
    history: [...(start.history ?? [])],
  };
  const writes: Array<{
    at: number;
    from: string | null;
    to: string | null;
  }> = [];
  let failAssign = false;
  let afterPoolRead: (() => void) | null = null;
  const person = (who: string) => ({
    id: who,
    email: who,
    displayName: who,
    name: who,
  });
  const transport: LinearTransport = async (query, variables) => {
    const op = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "anonymous";
    switch (op) {
      case "TrackerPoolIssue": {
        const answer = {
          issue: {
            identifier: "ENG-1",
            title: "filed",
            url: null,
            priority: 2,
            createdAt: iso(T0),
            updatedAt: iso(T0),
            state: { id: "s-todo", name: "Todo", type: "unstarted" },
            assignee:
              issue.assignee === null
                ? null
                : { id: issue.assignee, name: issue.assignee },
            labels: { pageInfo: { hasNextPage: false }, nodes: [] },
            allChildren: { nodes: [] },
            children: { pageInfo: { hasNextPage: false }, nodes: [] },
          },
        };
        afterPoolRead?.();
        return answer;
      }
      case "TrackerUsers":
        return {
          users: { nodes: [{ id: variables.who, name: variables.who }] },
        };
      case "TrackerAssignee":
        return {
          issue: {
            id: "uuid-1",
            assignee:
              issue.assignee === null
                ? null
                : { id: issue.assignee, name: issue.assignee },
          },
        };
      case "TrackerAssign": {
        if (failAssign) throw new Error("Linear refused the update");
        const to = (variables.input as { assigneeId: string | null })
          .assigneeId;
        writes.push({ at: clock.now(), from: issue.assignee, to });
        issue.assignee = to;
        if (to !== null && clock.now() >= T0 + WINDOW_MS)
          issue.history.push({ createdAt: iso(clock.now()), toAssignee: to });
        return { issueUpdate: { success: true } };
      }
      case "TrackerAssigneeHistory":
        return {
          issue: {
            history: {
              pageInfo: { hasNextPage: false, endCursor: null },
              // Like the adapter's other history read, leaves out what was
              // written inside the creation window.
              nodes: [
                ...(start.history ?? []).map((h, i) => ({
                  id: `s${i}`,
                  createdAt: h.createdAt,
                  fromAssignee: null,
                  toAssignee: { id: h.toAssignee },
                })),
                ...writes
                  .filter((w) => w.at >= T0 + WINDOW_MS)
                  .map((w, i) => ({
                    id: `w${i}`,
                    createdAt: iso(w.at),
                    fromAssignee: w.from === null ? null : { id: w.from },
                    toAssignee: w.to === null ? null : { id: w.to },
                  })),
              ],
            },
          },
        };
      case "TrackerAssignmentHistory":
        return {
          issue: {
            assignee: issue.assignee === null ? null : person(issue.assignee),
            history: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: issue.history.map((h, i) => ({
                id: `h${i}`,
                createdAt: h.createdAt,
                toAssignee: person(h.toAssignee),
                actor: h.byGuest === true ? { ...LEAD, guest: true } : LEAD,
              })),
            },
          },
        };
      default:
        throw new Error(`the fake Linear does not answer ${op}`);
    }
  };
  const tracker = linearTracker({
    team: "ENG",
    states: parseTrackerConfig({}).states,
    transport,
  });
  return {
    tracker,
    writes,
    failAssign: () => {
      failAssign = true;
    },
    /** Assign the issue as a person would, outside the code under test. */
    setAssignee: (who: string | null) => {
      issue.assignee = who;
    },
    /** Run `fn` just after each read of the issue is answered, as a racing person would. */
    onPoolRead: (fn: () => void) => {
      afterPoolRead = fn;
    },
  };
}
