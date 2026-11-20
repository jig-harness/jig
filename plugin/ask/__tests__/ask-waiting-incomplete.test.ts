/**
 * `jig ask --waiting` from a line some of whose repositories the newest tick
 * could not read: the answer names each one, why it was refused and when the
 * reading its part of the line is from, in the text and as a JSON field, so
 * a line built while every repository was refused does not read as one where
 * nothing waits.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type {
  LineRepo,
  LineSnapshot,
} from "../../dispatch/lib/dashboard-contract.ts";
import { writeLine } from "../../dispatch/lib/line-store.ts";
import type { WaitingAnswer } from "../lib/waiting.ts";
import { type AskWorld, askWorld, REPO } from "./ask-fixtures.ts";

let current: AskWorld | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

const REFUSAL =
  "the forge cannot say which repository this is: the rate limit holds the call, so nothing was sent";
const READ_AT = "2026-11-05T11:00:00.000Z";

function refused(path: string, lastSlug?: string): LineRepo {
  return {
    slug: null,
    ...(lastSlug === undefined ? {} : { lastSlug }),
    path,
    stages: ["pickup"],
    refused: REFUSAL,
    failedReads: [],
    notes: [],
    runId: "earlier",
    readAt: READ_AT,
  };
}

/** The line of a tick that could identify none of the repositories it was asked for. */
const LINE: LineSnapshot = {
  version: 1,
  runId: "2026-11-05T11-55-00-000Z-1-aaaaaaaa",
  startedAt: "2026-11-05T11:55:00.000Z",
  finishedAt: "2026-11-05T11:56:00.000Z",
  exitStatus: 0,
  apply: true,
  applyWithheld: null,
  intervalMs: 300_000,
  longestTickMs: 60_000,
  plugin: "1.2.3",
  accounts: [],
  lastAccount: null,
  sessions: [],
  needs: [],
  queue: [],
  repos: [refused("/srv/web", REPO), refused("/srv/new")],
};

describe("jig ask --waiting from a line with refused repositories", () => {
  it("lists a pickup held by a person, with the address and time to use when releasing it", async () => {
    const w = askWorld();
    current = w;
    writeLine(
      {
        ...LINE,
        repos: [],
        queue: [
          {
            source: "held",
            group: "held",
            repo: REPO,
            target: "#12",
            pr: null,
            item: "#12",
            url: null,
            title: "A held item",
            why: `held by maintainer at ${READ_AT}`,
            pickupHold: { by: "maintainer", at: READ_AT },
            stale: false,
            assignedBy: null,
            hold: null,
            launch: null,
          },
        ],
      },
      "{}",
      w.state,
    );
    const json = await w.ask(["--waiting", "--json"], w.away);
    expectSpawnExit(json, 0);
    const answer = JSON.parse(json.stdout) as WaitingAnswer;
    expect(answer.waiting).toEqual([
      expect.objectContaining({
        address: `pickup@${REPO}#12`,
        people: ["maintainer"],
        act: "release the pickup hold",
        since: READ_AT,
        reason: `held by maintainer at ${READ_AT}`,
      }),
    ]);
  });

  it("names each repository the newest tick could not read, why, and the reading its part is from", async () => {
    const w = askWorld();
    current = w;
    writeLine(LINE, "{}", w.state);

    const json = await w.ask(["--waiting", "--json"], w.away);
    expectSpawnExit(json, 0);
    const answer = JSON.parse(json.stdout) as WaitingAnswer;
    expect(answer.waiting).toEqual([]);
    expect(answer.unread).toBeNull();
    expect(answer.incomplete).toEqual([
      { repo: REPO, refused: REFUSAL, readAt: READ_AT },
      { repo: "/srv/new", refused: REFUSAL, readAt: null },
    ]);

    const text = await w.ask(["--waiting"], w.away);
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain("  none in what was read");
    expect(text.stdout).toContain(
      "the line is incomplete: 2 repositories were not read",
    );
    expect(text.stdout).toContain(`${REPO}: as read at ${READ_AT}; ${REFUSAL}`);
    expect(text.stdout).toContain(`/srv/new: never read; ${REFUSAL}`);
  });

  it("has an empty incomplete list when every repository was read", async () => {
    const w = askWorld();
    current = w;
    writeLine(
      {
        ...LINE,
        repos: [
          {
            ...refused("/srv/web"),
            slug: REPO,
            refused: null,
            readAt: LINE.startedAt,
          },
        ],
      },
      "{}",
      w.state,
    );
    const json = await w.ask(["--waiting", "--json"], w.away);
    expectSpawnExit(json, 0);
    expect((JSON.parse(json.stdout) as WaitingAnswer).incomplete).toEqual([]);
    const text = await w.ask(["--waiting"], w.away);
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain("  nothing");
    expect(text.stdout).not.toContain("not read");
  });
});
