/**
 * The write and comment half of each adapter's fake transport, shared by the
 * suites that race hosts for one item: the item's assignment, its state
 * change, and a comment store that adds, lists and deletes. A suite answers
 * the reads it cares about and passes every other call here.
 */
import { conn, type Call as GitHubCall } from "./github-fixtures.ts";
import {
  assignable,
  type Call as JiraCall,
  FACTORY,
  MEMBER,
} from "./jira-fixtures.ts";

const user = (login: string) => ({ id: `U_${login}`, login });

/** The factory's claim writes and comments on GitHub issue #5, kept in memory. */
export function githubClaimStore() {
  const item = { labels: [] as string[], logins: [] as string[] };
  const comments: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  let n = 0;
  const answer = (c: GitHubCall): unknown => {
    switch (c.op) {
      case "TrackerViewer":
        return { viewer: user("factory") };
      case "TrackerAssignees":
        return {
          repository: {
            issue: {
              id: "I_5",
              assignees: {
                totalCount: item.logins.length,
                nodes: item.logins.map(user),
              },
            },
          },
        };
      case "TrackerLabels":
        return {
          repository: {
            labels: conn([{ id: "LA_ip", name: "In Progress" }]),
          },
        };
      case "TrackerAssign":
        writes.push(c.op);
        item.logins = ["factory"];
        return { updateIssue: { issue: { id: "I_5" } } };
      case "TrackerAddLabels":
        writes.push(c.op);
        item.labels = ["In Progress"];
        return { addLabelsToLabelable: { clientMutationId: null } };
      case "TrackerComment":
        n++;
        comments.push({
          id: `IC_${n}`,
          body: String(c.variables.body),
          createdAt: new Date().toISOString(),
          authorAssociation: "MEMBER",
          viewerDidAuthor: true,
        });
        return { addComment: { clientMutationId: null } };
      case "TrackerComments":
        return {
          repository: { issue: { id: "I_5", comments: conn(comments) } },
        };
      case "TrackerDeleteComment": {
        const at = comments.findIndex((m) => m.id === c.variables.id);
        if (at >= 0) comments.splice(at, 1);
        return { deleteIssueComment: { clientMutationId: null } };
      }
      default:
        throw new Error(`unexpected ${c.op}`);
    }
  };
  return { item, comments, writes, user, answer };
}

/** The factory's claim writes and comments on Linear issue ENG-4. */
export function linearClaimStore(initialState: string) {
  const ME = { id: "u-me", name: "factory" };
  const item = { stateName: initialState, assignee: null as typeof ME | null };
  const comments: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  let n = 0;
  const STATE_IDS: Record<string, string> = {
    Todo: "s-todo",
    "In Progress": "s-ip",
  };
  const none = { pageInfo: { hasNextPage: false, endCursor: null } };
  const answer = (op: string, variables: Record<string, unknown>): unknown => {
    switch (op) {
      case "TrackerViewer":
        return { viewer: ME };
      case "TrackerAssignee":
        return { issue: { id: "uuid-4", assignee: item.assignee } };
      case "TrackerAssign":
        writes.push(op);
        item.assignee = ME;
        return { issueUpdate: { success: true } };
      case "TrackerIssueId":
        return { issue: { id: "uuid-4", team: { id: "t-1", key: "ENG" } } };
      case "TrackerStates":
        return {
          team: {
            states: {
              ...none,
              nodes: Object.entries(STATE_IDS).map(([name, id]) => ({
                id,
                name,
                type: "unstarted",
              })),
            },
          },
        };
      case "TrackerUpdate":
        writes.push(op);
        item.stateName = "In Progress";
        return { issueUpdate: { success: true } };
      case "TrackerComment":
        n++;
        comments.push({
          id: `c-${n}`,
          body: String(variables.body),
          createdAt: new Date(Date.now() + n).toISOString(),
          user: { id: ME.id, guest: false },
        });
        return { commentCreate: { success: true } };
      case "TrackerComments":
        return {
          issue: { id: "uuid-4", comments: { ...none, nodes: comments } },
        };
      case "TrackerDeleteComment": {
        const at = comments.findIndex((m) => m.id === variables.id);
        if (at >= 0) comments.splice(at, 1);
        return { commentDelete: { success: true } };
      }
      default:
        throw new Error(`unexpected ${op}`);
    }
  };
  return { ME, item, comments, writes, STATE_IDS, none, answer };
}

/** The factory's claim writes and comments on Jira issue ENG-1. */
export function jiraClaimStore(initialStatus: string) {
  const item = {
    status: initialStatus,
    category: "new" as "new" | "indeterminate",
    assignee: null as typeof FACTORY | null,
  };
  const comments: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  let n = 0;
  const answer = (c: JiraCall): unknown => {
    if (c.route === "PUT issue/ENG-1/assignee") {
      writes.push(c.route);
      item.assignee = FACTORY;
      return null;
    }
    if (c.route === "GET issue/ENG-1/transitions")
      return {
        transitions: [
          {
            id: "11",
            name: "to In Progress",
            to: {
              id: "s-InProgress",
              name: "In Progress",
              statusCategory: { key: "indeterminate" },
            },
            fields: {},
          },
        ],
      };
    if (c.route === "POST issue/ENG-1/transitions") {
      writes.push(c.route);
      item.status = "In Progress";
      item.category = "indeterminate";
      return null;
    }
    if (c.route === "GET user/assignable/search")
      return assignable(FACTORY.accountId, MEMBER.accountId)(c);
    if (c.route === "POST issue/ENG-1/comment") {
      n++;
      comments.push({
        id: String(1000 + n),
        author: FACTORY,
        body: c.body.body,
        created: new Date().toISOString().replace("Z", "+0000"),
      });
      return { id: String(1000 + n) };
    }
    if (c.route === "GET issue/ENG-1/comment")
      return {
        comments,
        startAt: 0,
        maxResults: 100,
        total: comments.length,
      };
    const del = /^DELETE issue\/ENG-1\/comment\/(\d+)$/.exec(c.route);
    if (del) {
      const at = comments.findIndex((m) => m.id === del[1]);
      if (at >= 0) comments.splice(at, 1);
      return null;
    }
    return new Error(`unexpected request ${c.route}`);
  };
  return { item, comments, writes, answer };
}
