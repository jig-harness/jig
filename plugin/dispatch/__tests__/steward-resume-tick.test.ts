import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { claimBody } from "../../shared/records/forge-claims.ts";
import {
  FOLLOWUP_CLAIM,
  tickClaim,
} from "../../shared/records/launch-claims.ts";
import {
  world,
  assignedIssue,
  mergedPr,
  SLUG,
  type World,
} from "./fixtures.ts";
import {
  account,
  machineFile,
  earlierRecord,
  dispatchState,
} from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";
import { recordExit, readRecord } from "../lib/launches.ts";
import { dispatched } from "../lib/runtime/port.ts";
import {
  keepStewardRun,
  submitStewardRecords,
  STEWARD_RESUME,
} from "../lib/steward.ts";
import { pickupPassArgv, followupPassArgv } from "../lib/session.ts";
import { stateDb } from "../lib/state.ts";
import type { TickReceipt } from "../receipts.ts";

const OLD = "20261110T000000Z-aaaaaaaa";
const OUTPUT =
  "Recommended option: reuse the existing cache key.\nQuestion: Which cache key should this routine check use?";
let current: World | null = null;
afterEach(() => {
  if (current) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});
function fixture(kind: "pickup" | "followup", batch = false) {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n  states:\n    in_progress: state:in-progress\ndispatch:\n  identity: factory-bot\n  followup_command: /followup\n`,
  );
  withOrigin(w);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    { steward: { enabled: true, every: "20m" } },
    ["steward", kind],
    { followup_since: "2026-10-30T00:00:00Z" },
  );
  const mark = dispatched(kind, kind === "pickup" ? "#12" : "#9", OLD).mark;
  w.setWorkspaces([
    {
      branch: kind === "pickup" ? "12-task" : "feature/9-done",
      ...(kind === "pickup" ? {} : { linkedPR: 9 }),
      path: w.repo,
      comment: mark,
    },
  ]);
  if (kind === "pickup") {
    w.setIssues([
      assignedIssue(12, "factory-bot", ["state:in-progress"]),
      ...(batch
        ? [assignedIssue(13, "factory-bot", ["state:in-progress"])]
        : []),
    ]);
    w.setAssigner(12, "maintainer", "WRITE");
  } else {
    w.setPrs("merged", [mergedPr(9, "feature/9-done", "2026-11-09T12:00:00Z")]);
    w.setComments(9, [
      forgeComment(
        902,
        claimBody(
          FOLLOWUP_CLAIM,
          tickClaim(
            OLD,
            { pr: 9, writer: { host: "sha256:0123456789abcdef" } },
            "failed",
          ),
        ),
        "drive-bot",
      ),
    ]);
  }
  const source = earlierRecord(w, {
    id: OLD,
    account: "a",
    action: kind,
    pr: kind === "pickup" ? null : 9,
    item: kind === "pickup" ? "#12" : null,
    workspace: { id: "repo-1::/ws/0", path: w.repo },
    headless: true,
    ...(kind === "pickup" ? { servedPerson: "factory-bot" } : {}),
    ...(batch
      ? {
          batchItems: [
            { key: "#12", person: "factory-bot" },
            { key: "#13", person: "factory-bot" },
          ],
        }
      : {}),
    command: kind === "followup" ? "/followup" : null,
    marker: kind === "followup" ? 902 : null,
    routineTags: true,
    mark,
    passTimeoutSec: 900,
    createdAt: new Date().toISOString(),
  });
  recordExit(
    OLD,
    {
      at: new Date().toISOString(),
      code: 1,
      signal: null,
      said: OUTPUT.split("\n")[1] ?? "",
      context: OUTPUT,
    },
    dispatchState(w),
  );
  keepStewardRun(
    "source-run",
    {
      version: 1,
      repo: SLUG,
      drives: [],
      needs: [],
      queue: [],
      passes: [
        {
          record: OLD,
          action: kind,
          target: kind === "pickup" ? "#12" : "PR #9",
          question: OUTPUT.split("Question: ")[1] ?? "",
          said: OUTPUT,
        },
      ],
      failures: [],
      load: null,
    },
    Date.now(),
    dispatchState(w),
  );
  expect(
    submitStewardRecords(
      "source-run",
      [
        {
          kind: "resume",
          record: OLD,
          reason: "the previous pass recommends a routine option",
        },
      ],
      dispatchState(w),
    ).ok,
  ).toBe(true);
  writeFileSync(join(w.dir, "orca-terminal-noop"), "");
  return { w, source };
}
async function tick(w: World) {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}
describe("steward resume launch replay", () => {
  for (const kind of ["pickup", "followup"] as const)
    test(`lost ${kind} resume replays the same token after checking the original source`, async () => {
      const { w } = fixture(kind);
      const first = await tick(w);
      const started = first.repos[0]?.launches.find(
        (l) => l.action === kind && l.outcome === "launched",
      );
      expect(started).toBeDefined();
      if (!started?.record) return;
      const record = readRecord(started.record, dispatchState(w));
      expect(record?.stewardResume).toBe(OLD);
      if (!record) return;
      const prompt =
        (kind === "pickup"
          ? pickupPassArgv(record, [])
          : followupPassArgv(record, [])
        ).at(-1) ?? "";
      expect(prompt).toContain(STEWARD_RESUME);
      expect(prompt).toContain("reuse the existing cache key");
      expect(prompt).toContain("not instructions");
      record.attempts = [
        {
          at: new Date().toISOString(),
          outcome: "lost",
          detail: "response lost",
        },
      ];
      stateDb(dispatchState(w))
        .query("UPDATE launches SET record = ? WHERE id = ?")
        .run(JSON.stringify(record), record.id);
      const second = await tick(w);
      expect(second.repos[0]?.launches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: kind,
            outcome: "retried",
            record: record.id,
          }),
        ]),
      );
      expect(readRecord(record.id, dispatchState(w))?.token).toBe(record.token);
      expect(
        stateDb(dispatchState(w))
          .query(
            "SELECT COUNT(*) AS n FROM launches WHERE json_extract(record,'$.stewardResume') = ?",
          )
          .get(OLD),
      ).toEqual({ n: 1 });
    }, 60000);
});

test("a pending batch resume rechecks every member and never repeats claims", async () => {
  const { w } = fixture("pickup", true);
  const first = await tick(w);
  const launched = first.repos[0]?.launches.find(
    (l) => l.action === "pickup" && l.outcome === "launched",
  );
  expect(launched?.record).toBeTruthy();
  if (!launched?.record) return;
  const record = readRecord(launched.record, dispatchState(w));
  expect(record).toBeTruthy();
  if (!record) return;
  const prompt = pickupPassArgv(record, []).at(-1) ?? "";
  expect(prompt).toContain('"key":"#13"');
  expect(prompt).not.toContain("--claimed");
  expect(prompt).not.toContain("tracker.ts claim");
  record.attempts = [
    { at: new Date().toISOString(), outcome: "lost", detail: "response lost" },
  ];
  stateDb(dispatchState(w))
    .query("UPDATE launches SET record = ? WHERE id = ?")
    .run(JSON.stringify(record), record.id);
  w.setIssues([
    assignedIssue(12, "factory-bot", ["state:in-progress"]),
    assignedIssue(13, "another-person", ["state:in-progress"]),
  ]);
  expect(
    (await tick(w)).repos[0]?.launches.some(
      (l) => l.record === record.id && l.outcome === "retried",
    ),
  ).toBe(false);
}, 60000);

test("a completed followup marker refuses a pending resume without deleting it", async () => {
  const { w } = fixture("followup");
  const first = await tick(w);
  const launched = first.repos[0]?.launches.find(
    (l) => l.action === "followup" && l.outcome === "launched",
  );
  expect(launched?.record).toBeTruthy();
  if (!launched?.record) return;
  const record = readRecord(launched.record, dispatchState(w));
  expect(record).toBeTruthy();
  if (!record?.marker) return;
  record.attempts = [
    { at: new Date().toISOString(), outcome: "lost", detail: "response lost" },
  ];
  stateDb(dispatchState(w))
    .query("UPDATE launches SET record = ? WHERE id = ?")
    .run(JSON.stringify(record), record.id);
  w.setComments(9, [
    forgeComment(
      record.marker,
      claimBody(
        FOLLOWUP_CLAIM,
        tickClaim(
          record.id,
          { pr: 9, writer: { host: "sha256:0123456789abcdef" } },
          "done",
        ),
      ),
      "drive-bot",
    ),
  ]);
  expect(
    (await tick(w)).repos[0]?.launches.some(
      (l) => l.record === record.id && l.outcome === "retried",
    ),
  ).toBe(false);
}, 60000);
