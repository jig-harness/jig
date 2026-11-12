/**
 * A fake Linear workspace behind a `LinearTransport`: it answers the
 * queries the served walk sends (the queue, the change probe, lookups by
 * key, one issue, an assignment's history) from an in-memory model of the
 * team's issues, and counts every request by operation name.
 */
import { parseTrackerConfig } from "../../skills/do-item/scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../../skills/do-item/scripts/lib/tracker/linear.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";

export interface FakeIssue {
  identifier: string;
  state: { name: string; type: string };
  assignee: string | null;
  updatedAt: string;
  labels: string[];
  parent: string | null;
  description: string;
  /** Keys of the issues that block this one. */
  blockedBy: string[];
}

const STATE_IDS: Record<string, string> = {};
/** The state names an assigned-issues filter asks for: its third clause. */
const statesOf = (and: Array<Record<string, unknown>>): string[] =>
  (and[2]?.state as { name: { in: string[] } } | undefined)?.name.in ?? [];
const page = (nodes: unknown[]) => ({
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes,
});

export class FakeLinear {
  readonly issues = new Map<string, FakeIssue>();
  readonly requests: string[] = [];

  add(issue: Partial<FakeIssue> & { identifier: string }): void {
    this.issues.set(issue.identifier, {
      state: { name: "Todo", type: "unstarted" },
      assignee: null,
      updatedAt: "2026-11-01T00:00:00.000Z",
      labels: [],
      parent: null,
      description: "",
      blockedBy: [],
      ...issue,
    });
  }

  /** Change an issue as a person would: its update time moves. */
  touch(key: string, at: string, change: Partial<FakeIssue> = {}): void {
    const issue = this.issues.get(key);
    if (issue === undefined) throw new Error(`no ${key}`);
    Object.assign(issue, change, { updatedAt: at });
  }

  tracker(): Tracker {
    return linearTracker({
      team: "ENG",
      states: parseTrackerConfig({}).states,
      transport: this.transport,
    });
  }

  count(): number {
    return this.requests.length;
  }

  private pool(i: FakeIssue): Record<string, unknown> {
    STATE_IDS[i.state.name] ??= `state-${Object.keys(STATE_IDS).length}`;
    return {
      identifier: i.identifier,
      title: i.identifier,
      url: null,
      priority: 2,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: i.updatedAt,
      state: { id: STATE_IDS[i.state.name], ...i.state },
      assignee:
        i.assignee === null ? null : { id: i.assignee, name: i.assignee },
      labels: {
        pageInfo: { hasNextPage: false },
        nodes: i.labels.map((name) => ({ name })),
      },
      children: {
        pageInfo: { hasNextPage: false },
        nodes: [...this.issues.values()]
          .filter(
            (c) =>
              c.parent === i.identifier &&
              !["completed", "canceled"].includes(c.state.type),
          )
          .map((c) => ({ id: c.identifier })),
      },
    };
  }

  private related(key: string) {
    const other = this.issues.get(key);
    return {
      identifier: key,
      state: { type: other?.state.type ?? "unstarted" },
    };
  }

  private queueNode(i: FakeIssue): Record<string, unknown> {
    const blocks = [...this.issues.values()].filter((o) =>
      o.blockedBy.includes(i.identifier),
    );
    const parent = i.parent === null ? null : this.issues.get(i.parent);
    return {
      ...this.pool(i),
      relations: page(
        blocks.map((o) => ({
          type: "blocks",
          relatedIssue: this.related(o.identifier),
        })),
      ),
      inverseRelations: page(
        i.blockedBy.map((k) => ({ type: "blocks", issue: this.related(k) })),
      ),
      parent:
        parent === undefined || parent === null
          ? null
          : {
              ...this.pool(parent),
              description: parent.description,
              parent:
                parent.parent === null ? null : { identifier: parent.parent },
            },
    };
  }

  /**
   * Whether an issue matches one `{ and: [{ team }, { number in }] }` group.
   * Linear drops the `number` clause of a bare `{ team, number }` element
   * of an `or` and matches the whole team, so the fake does too.
   */
  private inGroup(i: FakeIssue, g: Record<string, unknown>): boolean {
    const clauses = (g.and as Array<Record<string, unknown>> | undefined) ?? [
      { team: g.team },
    ];
    const [prefix, n] = i.identifier.split("-");
    return clauses.every((c) => {
      if ("team" in c)
        return prefix === (c.team as { key: { eq: string } }).key.eq;
      return (c.number as { in: number[] }).in.includes(Number(n));
    });
  }

  private assignedTo(i: FakeIssue, clause: Record<string, unknown>): boolean {
    const or = (
      clause.assignee as { or: Array<Record<string, { eqIgnoreCase: string }>> }
    ).or;
    const who = or[0]?.email?.eqIgnoreCase;
    return i.assignee !== null && i.assignee === who;
  }

  readonly transport: LinearTransport = async (query, variables) => {
    const op = /query (\w+)/.exec(query)?.[1] ?? "anonymous";
    this.requests.push(op);
    const all = [...this.issues.values()];
    const filter = (variables.filter ?? {}) as Record<string, unknown>;
    switch (op) {
      case "TrackerQueue": {
        const and = (filter.and ?? []) as Array<Record<string, unknown>>;
        const states = statesOf(and);
        const nodes = all.filter(
          (i) =>
            this.assignedTo(i, and[1] as Record<string, unknown>) &&
            states.includes(i.state.name),
        );
        // Pages as the query asks: its page size, the cursor an offset.
        const size = Number(/issues\(first: (\d+)/.exec(query)?.[1] ?? 50);
        const from = Number(variables.after ?? 0);
        const more = from + size < nodes.length;
        return {
          issues: {
            pageInfo: {
              hasNextPage: more,
              endCursor: more ? String(from + size) : null,
            },
            nodes: nodes.slice(from, from + size).map((i) => this.queueNode(i)),
          },
        };
      }
      case "TrackerPool": {
        const and = (filter.and ?? []) as Array<Record<string, unknown>>;
        const states = statesOf(and);
        return {
          issues: page(
            all
              .filter(
                (i) =>
                  this.assignedTo(i, and[1] as Record<string, unknown>) &&
                  states.includes(i.state.name),
              )
              .map((i) => this.pool(i)),
          ),
        };
      }
      case "TrackerRelations":
      case "TrackerInverseRelations": {
        const key = String(variables.id);
        const inverse = op === "TrackerInverseRelations";
        const nodes = inverse
          ? (this.issues.get(key)?.blockedBy ?? []).map((k) => ({
              id: `${k}>${key}`,
              type: "blocks",
              issue: { identifier: k },
            }))
          : all
              .filter((o) => o.blockedBy.includes(key))
              .map((o) => ({
                id: `${key}>${o.identifier}`,
                type: "blocks",
                relatedIssue: { identifier: o.identifier },
              }));
        return {
          issue: { [inverse ? "inverseRelations" : "relations"]: page(nodes) },
        };
      }
      case "TrackerChanges": {
        const [{ updatedAt }, { or }] = filter.and as [
          { updatedAt: { gt: string } },
          { or: Array<Record<string, unknown>> },
        ];
        const since = updatedAt.gt;
        const nodes = all.filter((i) => {
          if (i.updatedAt <= since) return false;
          return or.some((c) => {
            const clauses = c.and as Array<Record<string, unknown>> | undefined;
            const assignee = clauses?.find((x) => "assignee" in x);
            if (assignee !== undefined) return this.assignedTo(i, assignee);
            if ("parent" in c) {
              const parent =
                i.parent === null ? undefined : this.issues.get(i.parent);
              return (
                parent !== undefined &&
                this.inGroup(parent, c.parent as Record<string, unknown>)
              );
            }
            return this.inGroup(i, c);
          });
        });
        return {
          issues: {
            pageInfo: { hasNextPage: false },
            nodes: nodes.map((i) => ({
              identifier: i.identifier,
              updatedAt: i.updatedAt,
            })),
          },
        };
      }
      case "TrackerPoolIssues": {
        const groups = (filter.or ?? []) as Array<Record<string, unknown>>;
        const nodes = all.filter((i) => groups.some((g) => this.inGroup(i, g)));
        const size = Number(/issues\(first: (\d+)/.exec(query)?.[1] ?? 50);
        const from = Number(variables.after ?? 0);
        const more = from + size < nodes.length;
        return {
          issues: {
            pageInfo: {
              hasNextPage: more,
              endCursor: more ? String(from + size) : null,
            },
            nodes: nodes.slice(from, from + size).map((i) => this.pool(i)),
          },
        };
      }
      case "TrackerPoolIssue": {
        const i = this.issues.get(String(variables.id));
        return { issue: i === undefined ? null : this.pool(i) };
      }
      case "TrackerIssue": {
        const i = this.issues.get(String(variables.id));
        if (i === undefined) return { issue: null };
        return {
          issue: {
            id: i.identifier,
            identifier: i.identifier,
            title: i.identifier,
            description: i.description,
            url: null,
            updatedAt: i.updatedAt,
            priority: 2,
            state: i.state,
            labels: {
              pageInfo: { hasNextPage: false },
              nodes: i.labels.map((name) => ({ name })),
            },
            parent:
              i.parent === null
                ? null
                : { identifier: i.parent, title: i.parent },
            children: page([]),
            assignee: i.assignee === null ? null : { name: i.assignee },
            project: null,
          },
        };
      }
      case "TrackerAssignmentHistory": {
        const i = this.issues.get(String(variables.id));
        const user = {
          id: i?.assignee,
          email: i?.assignee,
          displayName: i?.assignee,
          name: i?.assignee,
        };
        return {
          issue: {
            assignee: user,
            history: page([
              {
                id: "h1",
                createdAt: "2026-10-02T00:00:00.000Z",
                toAssignee: user,
                actor: {
                  id: "lead",
                  name: "lead",
                  guest: false,
                  teams: { nodes: [{ key: "ENG" }] },
                },
              },
            ]),
          },
        };
      }
      default:
        throw new Error(`the fake Linear does not answer ${op}`);
    }
  };
}
