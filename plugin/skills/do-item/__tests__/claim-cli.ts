/**
 * `tracker.ts claim` run in its own process against a fake GitHub: the
 * claim's reads and writes, and the issues an item is blocked by.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentIso } from "../../../shared/time.ts";
import { conn, issueNode, oneIssue } from "./github-fixtures.ts";

export const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "preflight-fixture.ts",
);

/** Make `dir` a clone whose default branch (`origin/HEAD`) holds `config` as `.config/jig.yaml`. */
function defaultBranch(dir: string, config: string): void {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
      stderr: "pipe",
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".config"));
  writeFileSync(join(dir, ".config", "jig.yaml"), config);
  git("add", ".config/jig.yaml");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
}

/** An issue #5 is blocked by, on the fake GitHub; one with no `state` cannot be read. */
export interface Blocker {
  repo?: string;
  number: number;
  state?: "OPEN" | "CLOSED";
  title?: string;
  assignee?: string;
}

/** The relations #5's issue node carries: `blockedBy` each blocker, nothing else. */
function relationsOf(blockers: Blocker[]): Record<string, unknown> {
  const ref = (b: Blocker) => ({
    number: b.number,
    repository: { nameWithOwner: b.repo ?? "acme/app" },
  });
  return {
    blockedBy: conn(blockers.map(ref)),
    blocking: conn([]),
    relatesTo: conn([]),
    duplicateOf: null,
    timelineItems: conn([]),
  };
}

/** A blocker's issue node, `null` for one that cannot be read. */
function blockerNode(
  blockers: Blocker[],
  owner: string,
  name: string,
  number: number,
) {
  const slug = `${owner}/${name}`.toLowerCase();
  const b = blockers.find(
    (x) => x.number === number && (x.repo ?? "acme/app").toLowerCase() === slug,
  );
  if (b?.state === undefined) return null;
  return issueNode({
    repo: b.repo ?? "acme/app",
    number,
    state: b.state,
    ...(b.state === "CLOSED" ? { stateReason: "COMPLETED" } : {}),
    title: b.title ?? `Issue ${number}`,
    assignee: b.assignee ?? null,
    extra: { subIssues: conn([]) },
  });
}

/** Run `tracker.ts claim #5` (or `comment #5`) against a GraphQL endpoint answering as `world` does. */
export async function cli(
  labels: string[],
  logins: string[],
  race?: string,
  extra: {
    overlay?: string;
    env?: Record<string, string>;
    /** The default branch's `.config/jig.yaml` additions; absent, the clone names no default branch. */
    committed?: string;
    /** Requests the fake tracker records, by operation. */
    seen?: string[];
    /** The item's comments before the claim, as GitHub's comment nodes. */
    comments?: Array<Record<string, unknown>>;
    /** Fail the claim's comment post. */
    failComment?: boolean;
    /** Commit the comment before failing its response (lost response). */
    failCommentAfterWrite?: boolean;
    /** Fail TrackerComments reads. */
    failCommentsRead?: boolean;
    /** The issues #5 is blocked by; one with no state cannot be read. */
    blockers?: Blocker[];
    /** Sub-issues on #5, making it an epic. */
    subIssues?: Array<{ number: number; state?: "OPEN" | "CLOSED" }>;
    /** Arguments after `claim #5` (or command args when `command` is set). */
    args?: string[];
    /** Command to run instead of `claim`: e.g. `comment`. */
    command?: "claim" | "comment";
    /** Stdin text for `comment`. */
    stdin?: string;
    /** The repository's labels besides `In Progress`. */
    repoLabels?: string[];
  } = {},
) {
  let state = { labels, logins };
  const comments = [...(extra.comments ?? [])];
  const writeOps: string[] = [];
  const user = (login: string) => ({ id: `U_${login}`, login });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { query, variables } = (await request.json()) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
      let data: unknown;
      if (op === "TrackerViewer") data = { viewer: user("factory") };
      if (op === "TrackerAssignees")
        data = {
          repository: {
            issue: {
              id: "I_5",
              assignees: {
                totalCount: state.logins.length,
                nodes: state.logins.map(user),
              },
            },
          },
        };
      if (op === "TrackerIssue")
        data = oneIssue(
          variables.number === 5 &&
            String(variables.owner ?? "acme").toLowerCase() === "acme" &&
            String(variables.name ?? "app").toLowerCase() === "app"
            ? issueNode({
                number: 5,
                labels: state.labels,
                assignee: state.logins[0] ?? null,
                extra: {
                  subIssues: conn(
                    (extra.subIssues ?? []).map((s) => ({
                      id: `I_${s.number}`,
                      state: s.state ?? "OPEN",
                    })),
                  ),
                  ...relationsOf(extra.blockers ?? []),
                },
              })
            : blockerNode(
                extra.blockers ?? [],
                String(variables.owner ?? "acme"),
                String(variables.name ?? "app"),
                Number(variables.number),
              ),
        );
      if (op === "TrackerLabels")
        data = {
          repository: {
            labels: conn([
              { id: "LA_ip", name: "In Progress" },
              ...(extra.repoLabels ?? []).map((name) => ({
                id: `LA_${name}`,
                name,
              })),
            ]),
          },
        };
      const added = (variables.labelIds as string[] | undefined) ?? [];
      // Any label but In Progress: a label the claim adds besides its state's.
      const others = added
        .filter((id) => id !== "LA_ip")
        .map((id) => id.slice("LA_".length));
      if (op === "TrackerAssign") writeOps.push(op);
      if (op === "TrackerAddLabels")
        writeOps.push(others.length === 0 ? op : `${op} ${others.join(",")}`);
      if (op !== undefined) extra.seen?.push(op);
      if (op === "TrackerComment") {
        if (extra.failCommentAfterWrite === true) {
          writeOps.push(`${op} ${String(variables.body)}`);
          comments.push({
            id: `IC_${comments.length + 1}`,
            body: String(variables.body),
            createdAt: currentIso(),
            authorAssociation: "NONE",
            viewerDidAuthor: true,
          });
        } else if (extra.failComment !== true) {
          writeOps.push(`${op} ${String(variables.body)}`);
          comments.push({
            id: `IC_${comments.length + 1}`,
            body: String(variables.body),
            createdAt: currentIso(),
            authorAssociation: "NONE",
            viewerDidAuthor: true,
          });
          data = { addComment: { clientMutationId: null } };
        }
      }
      if (op === "TrackerComments" && extra.failCommentsRead !== true)
        data = {
          repository: { issue: { id: "I_5", comments: conn(comments) } },
        };
      if (op === "TrackerDeleteComment") {
        writeOps.push(`${op} ${String(variables.id)}`);
        const at = comments.findIndex((c) => c.id === variables.id);
        if (at >= 0) comments.splice(at, 1);
        data = { deleteIssueComment: { clientMutationId: null } };
      }
      if (op === "TrackerAssign") {
        const input = variables.input as { assigneeIds: string[] };
        state = {
          ...state,
          logins: input.assigneeIds.map((i) => i.slice(2)),
        };
        data = { updateIssue: { issue: { id: "I_5" } } };
      }
      if (op === "TrackerAddLabels" && others.length > 0) {
        state = { ...state, labels: [...state.labels, ...others] };
        data = { addLabelsToLabelable: { clientMutationId: null } };
      } else if (op === "TrackerAddLabels") {
        state = {
          labels: [...state.labels, "In Progress"],
          logins: race === undefined ? state.logins : [race],
        };
        data = { addLabelsToLabelable: { clientMutationId: null } };
      }
      return Response.json(
        data === undefined
          ? { errors: [{ message: `unhandled ${op}` }] }
          : { data },
      );
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "jig-claim-"));
  const overlay = join(dir, "overlay.yaml");
  // Both facets named, so no detection read precedes the claim's.
  const base =
    "issue_tracker:\n  adapter: github\n  github:\n    repository: acme/app\n  facets:\n    type: { store: label }\n    priority: { store: label }\n";
  writeFileSync(overlay, base + (extra.overlay ?? ""));
  if (extra.committed !== undefined) defaultBranch(dir, base + extra.committed);
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/tracker.ts"),
        extra.command ?? "claim",
        "#5",
        ...(extra.args ?? []),
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          JIG_OVERLAY: overlay,
          JIG_USER_LAYER: "off",
          JIG_GITHUB_GRAPHQL_URL: `http://127.0.0.1:${server.port}/graphql`,
          GH_TOKEN: "test-token",
          ...extra.env,
        },
        ...(extra.stdin === undefined
          ? {}
          : { stdin: new Response(extra.stdin) }),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const seen = existsSync(join(dir, "seen.json"))
      ? readFileSync(join(dir, "seen.json"), "utf8")
      : null;
    return { exitCode, stdout, stderr, writes: writeOps, seen };
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}
