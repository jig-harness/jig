// The nightly run's one tracking issue. A failing run opens it, or comments
// on it when it is already open, so consecutive failing nights add to one
// issue rather than opening another; the next passing run comments with its
// link and closes it. The issue is found by a marker line in its body among
// the open issues the reconciling identity opened, read through the REST
// listing (never the search index, which lags), so a person's issue that
// quotes the marker is never adopted.
//
// It reuses the GitHub adapter and the deadlines of M10's external-
// preconditions reconciler (modules/M10-environments-deploy/reference/
// external-preconditions/): a complete listing or none, and each tracker
// operation bounded. Its policy differs from that reconciler's, which keeps
// one issue's body current: here each night is a comment, so the people
// following the issue are told of every failing night.
import { isRecord } from "../../lib/record.ts";
import {
  ghProcess,
  type GhTransport,
  withDeadline,
  withinDeadline,
} from "../../modules/M10-environments-deploy/reference/external-preconditions/deadline.ts";
import { githubIssues } from "../../modules/M10-environments-deploy/reference/external-preconditions/github-issues.ts";
import {
  type IssueContent,
  TRACKER_DEADLINE_MS,
  type TrackerIssue,
} from "../../modules/M10-environments-deploy/reference/external-preconditions/reconcile.ts";

/** The marker line that names the nightly's tracking issue. */
export const MARKER = "<!-- jig:nightly-tracking-issue -->";

export class TrackingIssueError extends Error {}

/** What the reconciler needs of a tracker. `listOpen` returns every open issue or throws. */
export interface TrackingPort {
  listOpen(signal?: AbortSignal): Promise<TrackerIssue[]>;
  create(content: IssueContent, signal?: AbortSignal): Promise<TrackerIssue>;
  comment(id: string, body: string, signal?: AbortSignal): Promise<void>;
  close(id: string, signal?: AbortSignal): Promise<void>;
}

export interface TrackingInput {
  title: string;
  /** Whether the run failed. */
  red: boolean;
  /** The run's report: the new issue's body, or a comment. */
  report: string;
}

export interface TrackingResult {
  action: "created" | "commented" | "closed" | "unchanged";
  issue?: TrackerIssue;
}

/** Open, comment on or close the one tracking issue to match the run. */
export async function reconcileTrackingIssue(
  port: TrackingPort,
  input: TrackingInput,
  deadlineMs = TRACKER_DEADLINE_MS,
): Promise<TrackingResult> {
  const bounded = <T>(
    what: string,
    work: (signal: AbortSignal) => Promise<T>,
  ) =>
    withDeadline(
      deadlineMs,
      `tracker ${what}`,
      work,
      (message) => new TrackingIssueError(message),
    );
  const open = (
    await bounded("listing", (signal) => port.listOpen(signal))
  ).filter((issue) => issue.body.split(/\r?\n/).includes(MARKER));
  if (open.length > 1)
    throw new TrackingIssueError(
      `issues ${open.map((issue) => `#${issue.id}`).join(", ")} all track the nightly run; close all but one`,
    );
  const current = open[0];
  if (!input.red) {
    if (!current) return { action: "unchanged" };
    await bounded("comment", (signal) =>
      port.comment(current.id, input.report, signal),
    );
    await bounded("close", (signal) => port.close(current.id, signal));
    return { action: "closed", issue: current };
  }
  if (current) {
    await bounded("comment", (signal) =>
      port.comment(current.id, input.report, signal),
    );
    return { action: "commented", issue: current };
  }
  const content = { title: input.title, body: `${MARKER}\n\n${input.report}` };
  return {
    action: "created",
    issue: await bounded("create", (signal) => port.create(content, signal)),
  };
}

/**
 * The tracking port on GitHub: M10's issue adapter, listing only `creator`'s
 * issues, plus a comment through the same transport and deadline.
 */
export function githubTracking(
  repository: string,
  creator: string,
  api: GhTransport = ghProcess(),
): TrackingPort {
  const issues = githubIssues(repository, creator, api);
  return {
    listOpen: (signal) => issues.listOpen(signal),
    create: (content, signal) => issues.create(content, signal),
    close: (id, signal) => issues.close(id, signal),
    async comment(id, body, signal) {
      if (!/^[1-9][0-9]*$/.test(id))
        throw new TrackingIssueError(
          "GitHub issue id must be a positive integer",
        );
      const result = withinDeadline(
        api,
        signal,
        (message) => new TrackingIssueError(message),
      )([
        `repos/${repository}/issues/${id}/comments`,
        "--method",
        "POST",
        "-f",
        `body=${body}`,
      ]);
      if (!result.ok)
        throw new TrackingIssueError(
          `GitHub comment request failed: ${result.stderr}`,
        );
      let value: unknown;
      try {
        value = JSON.parse(result.stdout);
      } catch {
        throw new TrackingIssueError(
          "GitHub comment response is not valid JSON",
        );
      }
      if (!isRecord(value) || !Number.isSafeInteger(value.id))
        throw new TrackingIssueError("GitHub returned a malformed comment");
    },
  };
}
