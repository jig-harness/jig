import { describe, expect, test } from "bun:test";
import type { TrackerIssue } from "../../modules/M10-environments-deploy/reference/external-preconditions/reconcile.ts";
import {
  githubTracking,
  MARKER,
  reconcileTrackingIssue,
  type TrackingPort,
} from "./tracking-issue.ts";

/** An in-memory tracker: its issues, open or closed, and every call made to it. */
function tracker(initial: TrackerIssue[] = []) {
  const open = new Map(initial.map((issue) => [issue.id, issue]));
  const calls: string[] = [];
  const comments: Record<string, string[]> = {};
  let next = 100;
  const port: TrackingPort = {
    async listOpen() {
      calls.push("list");
      return [...open.values()];
    },
    async create(content) {
      const issue = { id: String(next++), ...content };
      calls.push(`create:${issue.id}`);
      open.set(issue.id, issue);
      return issue;
    },
    async comment(id, body) {
      calls.push(`comment:${id}`);
      comments[id] = [...(comments[id] ?? []), body];
    },
    async close(id) {
      calls.push(`close:${id}`);
      open.delete(id);
    },
  };
  return { port, calls, comments, open };
}

const red = (report: string) => ({
  title: "The nightly run fails on main",
  red: true,
  report,
});
const green = (report: string) => ({
  title: "The nightly run fails on main",
  red: false,
  report,
});

describe("the nightly run's tracking issue", () => {
  test("two failing nights update one issue and a passing night closes it", async () => {
    const { port, calls, comments, open } = tracker([
      {
        id: "5",
        title: "Another bot issue",
        body: "<!-- jig:external-preconditions:jig-delivery -->",
      },
    ]);
    const first = await reconcileTrackingIssue(
      port,
      red("night 1: gates (windows, 3/7) failed"),
    );
    expect(first.action).toBe("created");
    expect(first.issue?.body).toBe(
      `${MARKER}\n\nnight 1: gates (windows, 3/7) failed`,
    );
    const second = await reconcileTrackingIssue(port, red("night 2"));
    expect(second).toMatchObject({ action: "commented", issue: { id: "100" } });
    const third = await reconcileTrackingIssue(port, green("night 3 passed"));
    expect(third).toMatchObject({ action: "closed", issue: { id: "100" } });
    expect(calls).toEqual([
      "list",
      "create:100",
      "list",
      "comment:100",
      "list",
      "comment:100",
      "close:100",
    ]);
    expect(comments["100"]).toEqual(["night 2", "night 3 passed"]);
    expect([...open.keys()]).toEqual(["5"]);
  });

  test("a passing night with no open issue changes nothing", async () => {
    const { port, calls } = tracker();
    expect(await reconcileTrackingIssue(port, green("passed"))).toEqual({
      action: "unchanged",
    });
    expect(calls).toEqual(["list"]);
  });

  test("an issue that only quotes the marker inside a line is not the tracking issue", async () => {
    const { port, calls } = tracker([
      { id: "7", title: "x", body: `see \`${MARKER}\`` },
    ]);
    expect((await reconcileTrackingIssue(port, red("r"))).action).toBe(
      "created",
    );
    expect(calls).toContain("create:100");
  });

  test("two open tracking issues are refused rather than guessed between", async () => {
    const { port, calls } = tracker([
      { id: "7", title: "a", body: `${MARKER}\n\nx` },
      { id: "8", title: "b", body: `${MARKER}\r\n\r\ny` },
    ]);
    await expect(reconcileTrackingIssue(port, red("r"))).rejects.toThrow(
      "#7, #8",
    );
    expect(calls).toEqual(["list"]);
  });

  test("a tracker that does not answer fails the reconciliation at its deadline", async () => {
    const { port } = tracker();
    port.listOpen = () => new Promise(() => undefined);
    await expect(reconcileTrackingIssue(port, red("r"), 20)).rejects.toThrow(
      "did not finish within 20 ms",
    );
  });

  test("on GitHub, a comment is posted to the issue's comments", async () => {
    const calls: string[][] = [];
    const api = (args: string[]) => {
      calls.push(args);
      return { ok: true, stdout: JSON.stringify({ id: 1 }), stderr: "" };
    };
    await githubTracking("team/project", "github-actions[bot]", api).comment(
      "12",
      "the report",
    );
    expect(calls).toEqual([
      [
        "repos/team/project/issues/12/comments",
        "--method",
        "POST",
        "-f",
        "body=the report",
      ],
    ]);
    const refused = () => ({ ok: false, stdout: "", stderr: "HTTP 403" });
    await expect(
      githubTracking("team/project", "github-actions[bot]", refused).comment(
        "12",
        "r",
      ),
    ).rejects.toThrow("HTTP 403");
    await expect(
      githubTracking("team/project", "github-actions[bot]", api).comment(
        "1/x",
        "r",
      ),
    ).rejects.toThrow("positive integer");
  });
});
