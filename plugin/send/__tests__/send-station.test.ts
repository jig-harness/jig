/**
 * `jig send followup@…|pickup@…|drive@… answer <key> --approve|--choose`
 * to a need's decision other than a drive's park: read from this machine's
 * newest line, bound to the digest the person read, and written as the
 * comment a person could type on the need's pull request or forge issue.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type {
  LineNeed,
  LineSnapshot,
} from "../../dispatch/lib/dashboard-contract.ts";
import { writeLine } from "../../dispatch/lib/line-store.ts";
import {
  stationContextOf,
  stationDecision,
} from "../../dispatch/lib/line-station.ts";
import type { Action } from "../../dispatch/lib/types.ts";
import { decodeMarker } from "../../shared/records/envelope.ts";
import {
  pullRequest,
  REPO,
  type SendWorld,
  sendWorld,
} from "./send-fixtures.ts";

let current: SendWorld | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function needOf(
  action: Action & { cause: LineNeed["cause"] },
  fields: Partial<LineNeed>,
): LineNeed {
  const decision = stationDecision(
    action,
    stationContextOf(REPO, { tracker: { adapter: "github" } }),
  );
  if (decision === null) throw new TypeError("the fixture frames no decision");
  const pr = /^PR #(\d+)$/.exec(action.target);
  return {
    cause: action.cause,
    stage: "followup",
    repo: REPO,
    target: action.target,
    pr: pr === null ? null : Number(pr[1]),
    item: pr === null ? action.target : null,
    url: null,
    title: null,
    since: "2026-11-12T10:00:00.000Z",
    reason: action.reason,
    decisions: [decision],
    notified: null,
    workspaces: [],
    ...fields,
  };
}

const FAILED = needOf(
  {
    stage: "notify",
    target: "PR #12",
    record: "forge",
    reason: "failed follow-up",
    cause: "followup-failed",
    evidence: { marker: 41, record: "20261112T101301Z-33c6fa5f" },
  },
  { url: `https://github.com/${REPO}/pull/12` },
);

const STALLED = needOf(
  {
    stage: "notify",
    target: "#513",
    record: "tracker",
    reason: "stalled pickup",
    cause: "stalled",
    evidence: { state: "In Progress" },
  },
  { stage: "pickup", url: `https://github.com/${REPO}/issues/513` },
);

function line(needs: LineNeed[]): LineSnapshot {
  return {
    version: 1,
    runId: "2026-11-12T10-00-00-000Z-1-aaaaaaaa",
    startedAt: "2026-11-12T10:00:00.000Z",
    finishedAt: "2026-11-12T10:01:00.000Z",
    exitStatus: 0,
    apply: true,
    applyWithheld: null,
    intervalMs: 300_000,
    longestTickMs: 60_000,
    plugin: "1.2.3",
    accounts: [],
    lastAccount: null,
    sessions: [],
    needs,
    queue: [],
    ready: [],
    repos: [],
  } as unknown as LineSnapshot;
}

function world(): SendWorld {
  current = sendWorld();
  writeLine(line([FAILED, STALLED]), "{}", current.state);
  pullRequest(current, 12, [], []);
  current.api(`repos/${REPO}/issues/513/comments`, []);
  return current;
}

/** The bodies of the comments the send posted, with where each went. */
function posted(w: SendWorld): Array<{ path: string; body: string }> {
  return w.writes().map((args) => ({
    path: args.find((a) => a.includes("/comments")) ?? "",
    body: (args.find((a) => a.startsWith("body=")) ?? "").slice(5),
  }));
}

const FOLLOWUP = `followup@${REPO}#12`;
const DIGEST = FAILED.decisions[0]?.digest ?? "";

describe("jig send … answer to a need's decision", () => {
  it("prints the decision's digest, the option in full and the command to send on a dry run, writing nothing", async () => {
    const w = world();
    const dry = await w.send([
      FOLLOWUP,
      "answer",
      "followup",
      "--approve",
      "--dry-run",
    ]);
    expectSpawnExit(dry, 0);
    expect(dry.stdout).toContain(DIGEST);
    expect(dry.stdout).toContain("Run it again (the recommended option)");
    expect(dry.stdout).toContain(
      `jig send ${FOLLOWUP} answer followup --approve --decision ${DIGEST}`,
    );
    expect(w.writes()).toEqual([]);
  });

  it("writes the answer the tick reads on the pull request, bound to the digest", async () => {
    const w = world();
    const sent = await w.send([
      FOLLOWUP,
      "answer",
      "followup",
      "--choose",
      "leave it to me",
      "--decision",
      DIGEST,
    ]);
    expectSpawnExit(sent, 0);
    const [first] = posted(w);
    expect(first?.path).toContain(`repos/${REPO}/issues/12/comments`);
    expect(first?.body.split("\n")[0]).toBe(
      `answer followup: choose Leave it to me [${DIGEST}]`,
    );
    const read = decodeMarker(
      first?.body ?? "",
      "jig-send-answer",
      "drive-answer",
    );
    expect(read.ok && read.value.payload).toMatchObject({
      decision: DIGEST,
      choice: { option: "Leave it to me", form: "choose" },
    });
  });

  it("answers a pickup's decision on its forge issue", async () => {
    const w = world();
    const digest = STALLED.decisions[0]?.digest ?? "";
    const sent = await w.send([
      `pickup@${REPO}#513`,
      "answer",
      "pickup",
      "--approve",
      "--decision",
      digest,
    ]);
    expectSpawnExit(sent, 0);
    expect(posted(w)[0]?.path).toContain(`repos/${REPO}/issues/513/comments`);
  });

  it("refuses words, a stale or missing digest, an option the decision does not offer, a key it has not, and --all, writing nothing", async () => {
    const w = world();
    const refusals: Array<[string[], string]> = [
      [[FOLLOWUP, "answer", "followup", "run", "it"], "not words"],
      [[FOLLOWUP, "answer", "followup", "--approve"], "--dry-run"],
      [
        [
          FOLLOWUP,
          "answer",
          "followup",
          "--approve",
          "--decision",
          "0123456789ab",
        ],
        "its facts changed",
      ],
      [
        [
          FOLLOWUP,
          "answer",
          "followup",
          "--choose",
          "Merge it",
          "--decision",
          DIGEST,
        ],
        "names no option",
      ],
      [[FOLLOWUP, "answer", "pickup", "--approve"], "its keys are followup"],
      [[FOLLOWUP, "answer", "--all", "--approve"], "by its key"],
    ];
    for (const [args, says] of refusals) {
      const r = await w.send(args);
      expectSpawnExit(r, 1, args.join(" "));
      expect(r.stderr).toContain(says);
    }
    expect(w.writes()).toEqual([]);
  });
});
