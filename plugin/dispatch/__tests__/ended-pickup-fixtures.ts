import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import type { SessionsReport } from "../lib/runtime/port.ts";
import { SLUG } from "./fixtures.ts";

const PATH = "/work/example-repo-12";
export const BRANCH = "12-issue-12";

/** The ended pickup of #12 this host launched, in the workspace at `PATH`. */
export function endedPickup(id: string, exitAt: string): ReadRecord {
  return {
    record: {
      id,
      action: "pickup",
      repo: SLUG,
      item: "#12",
      pr: null,
      released: false,
      workspace: { id: "repo-1::12", path: PATH },
      claimedItems: ["#12"],
    } as unknown as LaunchRecord,
    state: {
      kind: "ended",
      exit: { at: exitAt, code: 0, signal: null },
      process: null,
    },
    result: null,
  };
}

/** The runtime's answer: the launch's workspace on its branch, no agent running. */
export const idleSessions: SessionsReport = {
  ok: true,
  source: "fake",
  workspaces: [
    {
      id: "repo-1::12",
      path: PATH,
      branch: BRANCH,
      items: ["#12"],
      prs: [31],
      agents: [],
      unverifiableTerminals: 0,
      comment: "",
      unread: null,
      name: "",
    },
  ],
};
