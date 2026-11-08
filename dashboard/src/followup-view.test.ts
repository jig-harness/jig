import { expect, test } from "bun:test";
import { fixture } from "../fixtures.ts";
import { queued, drive, need } from "../fixture-line.ts";
import {
  followupCounts,
  queuedFollowup,
  runningFollowup,
} from "./followup-view.ts";

class FixtureError extends Error {}

test("follow-ups distinguish waiting, working and failed PRs without counting a running PR twice", () => {
  const line = fixture("quiet").line;
  if (!line) throw new FixtureError("Missing fixture line");
  line.queue = [
    queued({
      source: "merged",
      group: "starts",
      title: "Change",
      why: "Merge observed",
      repo: "example-org/web",
      pr: 7,
    }),
    queued({
      source: "merged",
      group: "starts",
      title: "Change",
      why: "Merge observed",
      repo: "example-org/web",
      pr: 8,
    }),
  ];
  line.sessions = [
    {
      ...drive({
        account: "a",
        created: 60,
        title: "Change",
        repo: "example-org/web",
        pr: 8,
      }),
      stage: "followup",
    },
  ];
  line.needs = [
    need({
      cause: "followup-failed",
      stage: "followup",
      repo: "example-org/web",
      pr: 9,
      title: "Change",
      since: 60,
      reason: "Failed",
    }),
  ];
  expect(followupCounts(line, Date.parse(line.finishedAt))).toEqual({
    "Follow-up needs attention": 1,
    "Follow-up running": 1,
    "Awaiting follow-up": 1,
  });
});

test("a refused launch and an unknown session are never called running or awaiting a free slot", () => {
  expect(queuedFollowup("never")).toBe("Follow-up blocked");
  expect(queuedFollowup("reported")).toBe("Follow-up not scheduled");
  expect(runningFollowup("unknown")).toBe("Follow-up state unknown");
  expect(runningFollowup("pending")).toBe("Follow-up starting");
  expect(runningFollowup("waitOther")).toBe("Follow-up waiting");
});
