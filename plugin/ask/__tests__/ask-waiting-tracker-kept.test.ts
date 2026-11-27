/**
 * `jig ask --waiting` from a line where the newest tick had no credential
 * for a repository's tracker, so its tracker part is kept from the last
 * reading that had one (`trackerKept`): the answer names that reading's time
 * and what was missing, in the text and as a JSON field, so kept cards do
 * not read as fresh.
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

const REASON = "no Linear key configured";
const KEPT_AT = "2026-11-05T09:30:00.000Z";
const KEPT_RUN = "2026-11-05T09-30-00-000Z-1-bbbbbbbb";
const RUN = "2026-11-05T11-55-00-000Z-1-aaaaaaaa";
const OTHER = "example-org/api";

function repo(path: string, slug: string): LineRepo {
  return {
    slug,
    path,
    stages: ["pickup"],
    tracker: { adapter: "linear" },
    refused: null,
    failedReads: [],
    notes: [],
    runId: RUN,
    readAt: "2026-11-05T11:55:00.000Z",
  };
}

const LINE: LineSnapshot = {
  version: 1,
  runId: RUN,
  startedAt: "2026-11-05T11:55:00.000Z",
  finishedAt: "2026-11-05T11:56:00.000Z",
  exitStatus: 9,
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
  repos: [
    {
      ...repo("/srv/web", REPO),
      trackerKept: { readAt: KEPT_AT, runId: KEPT_RUN, reason: REASON },
    },
    {
      ...repo("/srv/new", "example-org/new"),
      trackerKept: { readAt: null, reason: REASON },
    },
    repo("/srv/api", OTHER),
  ],
};

describe("jig ask --waiting from a line with a kept tracker part", () => {
  it("names each repository whose tracker part is kept, the reading it is from and why", async () => {
    const w = askWorld();
    current = w;
    writeLine(LINE, "{}", w.state);

    const json = await w.ask(["--waiting", "--json"], w.away);
    expectSpawnExit(json, 0);
    const answer = JSON.parse(json.stdout) as WaitingAnswer;
    expect(answer.incomplete).toEqual([]);
    expect(answer.trackerKept).toEqual([
      { repo: REPO, readAt: KEPT_AT, runId: KEPT_RUN, reason: REASON },
      { repo: "example-org/new", readAt: null, runId: null, reason: REASON },
    ]);

    const text = await w.ask(["--waiting"], w.away);
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain(
      "the tracker part is kept: the newest tick had no credential for 2 repositories' trackers",
    );
    expect(text.stdout).toContain(
      `${REPO}: as read at ${KEPT_AT} (tick ${KEPT_RUN}); ${REASON}`,
    );
    expect(text.stdout).toContain(
      `example-org/new: never read with a credential; ${REASON}`,
    );
    expect(text.stdout).not.toContain(`${OTHER}:`);
  });

  it("names none when every tracker was asked", async () => {
    const w = askWorld();
    current = w;
    writeLine({ ...LINE, repos: [repo("/srv/api", OTHER)] }, "{}", w.state);
    const json = await w.ask(["--waiting", "--json"], w.away);
    expectSpawnExit(json, 0);
    expect((JSON.parse(json.stdout) as WaitingAnswer).trackerKept).toEqual([]);
    const text = await w.ask(["--waiting"], w.away);
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain("  nothing");
    expect(text.stdout).not.toContain("tracker part is kept");
  });
});
