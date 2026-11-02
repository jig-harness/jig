/**
 * The workspaces the dispatcher started sessions in since a time, found by
 * the dispatched mark on their launch records, not by their names: a skill
 * may rename a workspace to what the work became, and the record still
 * names the workspace it launched into. Each is read back from the session
 * runtime for the name it carries now and for whether its comment still
 * carries the mark. What the morning report lists as dispatched.
 */
import { stateRoot } from "../receipts.ts";
import { type LaunchRecord, markedSince } from "./launches.ts";
import { orcaRuntime } from "./runtime/orca.ts";
import {
  marksIn,
  type SessionRuntime,
  type Workspace,
} from "./runtime/port.ts";
import { failureText } from "./text.ts";

export interface DispatchedWorkspace {
  /** When the launch record was written. */
  at: string;
  /** The repository's `owner/name`. */
  repo: string;
  /** The launch record's id. */
  record: string;
  /** The mark the record keeps: the stage, the key and the record's id. */
  mark: string;
  /** The workspace's path, as the record names it; `null` when it names none. */
  path: string | null;
  /** The name the workspace carries now; `null` when the runtime did not list it or could not be read. */
  name: string | null;
  /** Whether its comment carries a mark of the same stage and key; `null` when it was not read. */
  marked: boolean | null;
  /** Why `name` is `null`, in a few words. */
  note: string | null;
}

const NO_JOIN = { keys: null, branchPattern: "", pullRequests: [] } as const;

/** The workspace a record launched into, among the runtime's. */
function launchedInto(
  workspaces: Workspace[],
  at: { id: string; path: string },
): Workspace | undefined {
  return workspaces.find((w) => w.id === at.id || w.path === at.path);
}

/** Whether a comment carries a mark of the same stage and key as `mark`. */
function carriesMark(comment: string, mark: string): boolean {
  const [own] = marksIn(mark);
  return own !== undefined && marksIn(comment).some((m) => m.name === own.name);
}

/**
 * The launch records with a mark written at or after `since`
 * (milliseconds), oldest first, each with the name its workspace carries
 * now; `unread` names what could not be read.
 */
export async function dispatchedSince(
  since: number,
  root: string = stateRoot(),
  runtime: SessionRuntime = orcaRuntime(),
): Promise<{ workspaces: DispatchedWorkspace[]; unread: string[] }> {
  let read: ReturnType<typeof markedSince>;
  try {
    read = markedSince(since, root);
  } catch (error) {
    return {
      workspaces: [],
      unread: [
        `the dispatcher's launch records could not be read (${failureText(error)})`,
      ],
    };
  }
  const unread = read.unreadable.map((u) => `${u} does not read`);
  // One read of the runtime per repository.
  const lists = new Map<string, Workspace[] | string>();
  const out: DispatchedWorkspace[] = [];
  for (const r of read.records) {
    let listed = lists.get(r.repo);
    if (listed === undefined) {
      listed = await workspacesOf(runtime, r.repo, r.repoPath);
      lists.set(r.repo, listed);
      if (typeof listed === "string") unread.push(listed);
    }
    out.push(entryOf(r, listed, runtime.name));
  }
  return { workspaces: out, unread };
}

/** One record's entry, its workspace looked up among the runtime's (`listed`, or why they could not be read). */
function entryOf(
  r: LaunchRecord,
  listed: Workspace[] | string,
  runtime: string,
): DispatchedWorkspace {
  const base = {
    at: r.createdAt,
    repo: r.repo,
    record: r.id,
    mark: r.mark ?? "",
    path: r.workspace?.path ?? null,
  };
  const unknown = (note: string) => ({
    ...base,
    name: null,
    marked: null,
    note,
  });
  if (r.workspace === null) return unknown("no workspace was opened");
  if (typeof listed === "string")
    return unknown(`${runtime} could not be read`);
  const found = launchedInto(listed, r.workspace);
  if (found === undefined) return unknown(`${runtime} no longer lists it`);
  return {
    ...base,
    name: found.name,
    marked: carriesMark(found.comment, base.mark),
    note: null,
  };
}

/** The runtime's workspaces of one repository, or why they could not be read. */
async function workspacesOf(
  runtime: SessionRuntime,
  slug: string,
  path: string,
): Promise<Workspace[] | string> {
  try {
    const report = await runtime.sessions(
      { slug, path, defaultBranch: "" },
      NO_JOIN,
    );
    return report.ok
      ? report.workspaces
      : `the names of ${slug}'s dispatched workspaces could not be read from ${runtime.name} (${report.reason})`;
  } catch (error) {
    return `the names of ${slug}'s dispatched workspaces could not be read from ${runtime.name} (${failureText(error)})`;
  }
}
