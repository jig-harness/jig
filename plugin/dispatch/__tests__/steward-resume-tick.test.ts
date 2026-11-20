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
  claimStewardRecord,
  judgedResumes,
  markStewardEffect,
  keepStewardRun,
  readStewardDigest,
  stewardRecords,
  submitStewardRecords,
  STEWARD_RESUME,
} from "../lib/steward.ts";
import { framedResultOf } from "../lib/framed-result.ts";
import { recordResult } from "../lib/launch-result.ts";
import { recordReport } from "../lib/closing-report-store.ts";
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
function fixture(
  kind: "pickup" | "followup",
  batch = false,
  output = OUTPUT,
  catalog = false,
) {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n  states:\n    in_progress: state:in-progress\ndispatch:\n  identity: factory-bot\n  followup_command: /followup\n${catalog ? "drive:\n  change_areas_catalog: .config/change-areas.yaml\n" : ""}`,
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
    ...(kind === "pickup"
      ? {
          servedPerson: "factory-bot",
          relaunchOf: "20261118T050000Z-cccccccc",
          relaunchHead: "1".repeat(40),
        }
      : {}),
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
      said: output.split("\n").at(-1) ?? "",
      context: output,
    },
    dispatchState(w),
  );
  // The pass wrote its closing report, so it is not put to the steward as a run without one.
  recordReport(
    OLD,
    {
      schema: "closing-report/v1",
      concluded: "Stopped on a routine question.",
      suggested_next: {
        step: "Answer the question.",
        owner: "person",
        act: "Decide",
      },
      cause: "needs-person",
    },
    "agent",
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
          question: output.split("Question: ")[1] ?? "",
          said: output,
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
async function tick(w: World, exit = 0) {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, exit);
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
      expect(record.relaunchOf).toBeUndefined();
      expect(record.relaunchHead).toBeUndefined();
      const prompt =
        (kind === "pickup"
          ? pickupPassArgv(record, [])
          : followupPassArgv(record, [])
        ).at(-1) ?? "";
      expect(prompt).toContain(STEWARD_RESUME);
      expect(prompt).not.toContain("finishes the stalled pickup");
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

describe("steward resumes while serialization is undecided", () => {
  const launchOf = (receipt: TickReceipt, kind: string) =>
    receipt.repos[0]?.launches.find(
      (l) => l.action === kind && l.outcome === "launched",
    );

  test("a pickup resume waits for the catalog and launches once it reads", async () => {
    const { w } = fixture("pickup", false, OUTPUT, true);
    expect(launchOf(await tick(w, 1), "pickup")).toBeUndefined();
    expect(
      stateDb(dispatchState(w))
        .query(
          "SELECT COUNT(*) AS n FROM launches WHERE json_extract(record,'$.stewardResume') = ?",
        )
        .get(OLD),
    ).toEqual({ n: 0 });
    w.setRepoFile(
      ".config/change-areas.yaml",
      'areas:\n  docs:\n    paths: ["docs/**"]\n',
    );
    expect(launchOf(await tick(w), "pickup")).toBeDefined();
  }, 60000);

  test("a followup resume is not withheld", async () => {
    const { w } = fixture("followup", false, OUTPUT, true);
    expect(launchOf(await tick(w, 1), "followup")).toBeDefined();
  }, 60000);
});

test("a refused duplicate resume never blocks the replay of the lost one", async () => {
  const { w } = fixture("pickup");
  const first = await tick(w);
  const started = first.repos[0]?.launches.find(
    (l) => l.action === "pickup" && l.outcome === "launched",
  );
  expect(started?.record).toBeTruthy();
  if (!started?.record) return;
  const lose = () => {
    const record = readRecord(started.record as string, dispatchState(w));
    expect(record).toBeTruthy();
    if (!record) return;
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
  };
  const digest = readStewardDigest("source-run", dispatchState(w));
  expect(digest.ok).toBe(true);
  if (!digest.ok) return;
  keepStewardRun("duplicate-run", digest.value, Date.now(), dispatchState(w));
  const submitted = submitStewardRecords(
    "duplicate-run",
    [{ kind: "resume", record: OLD, reason: "the same pass again" }],
    dispatchState(w),
  );
  expect(submitted).toMatchObject({ ok: true, value: "submitted" });
  await tick(w);
  expect(
    stewardRecords(SLUG, dispatchState(w)).filter(
      (r) => r.run === "duplicate-run" && r.effect === "refused",
    ),
  ).toHaveLength(1);
  lose();
  const replayed = await tick(w);
  expect(
    replayed.repos[0]?.launches.some(
      (l) => l.record === started.record && l.outcome === "retried",
    ),
  ).toBe(true);
}, 90000);

test("an earlier refusal of a resume naming a pass outside its digest leaves the pass offered", () => {
  const { w } = fixture("pickup");
  const digest = readStewardDigest("source-run", dispatchState(w));
  expect(digest.ok).toBe(true);
  if (!digest.ok) return;
  keepStewardRun(
    "older-run",
    { ...digest.value, passes: [] },
    Date.now(),
    dispatchState(w),
  );
  expect(
    submitStewardRecords(
      "older-run",
      [{ kind: "resume", record: OLD, reason: "named wrongly" }],
      dispatchState(w),
    ),
  ).toMatchObject({ ok: true, value: "submitted" });
  const [older] = stewardRecords(SLUG, dispatchState(w)).filter(
    (r) => r.run === "older-run",
  );
  expect(older).toBeTruthy();
  if (!older) return;
  expect(claimStewardRecord(older.id, dispatchState(w))).toBe(true);
  markStewardEffect(older.id, "refused", dispatchState(w));
  expect(judgedResumes(SLUG, dispatchState(w)).has(OLD)).toBe(false);
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

function resumeUnplaced(receipt: TickReceipt): string[] {
  return (receipt.repos[0]?.unplaced ?? [])
    .filter((u) => u.target.startsWith("steward record "))
    .map((u) => u.reason);
}

async function refusedOnce(
  w: World,
  reason: string,
  settled = true,
): Promise<void> {
  const first = await tick(w);
  expect(first.repos[0]?.launches.some((l) => l.outcome === "launched")).toBe(
    false,
  );
  expect(resumeUnplaced(first)).toEqual([expect.stringContaining(reason)]);
  const [kept] = stewardRecords(SLUG, dispatchState(w));
  expect(kept).toMatchObject({
    applied: true,
    effect: settled ? "refused" : "refused-open",
  });
  expect(judgedResumes(SLUG, dispatchState(w)).has(OLD)).toBe(settled);
  expect(resumeUnplaced(await tick(w))).toEqual([]);
}

test("a resume whose pass recommended no option is refused once with its reason", async () => {
  const { w } = fixture(
    "pickup",
    false,
    "The scope choice needs a person.\nQuestion: Which scope should #12 take?",
  );
  await refusedOnce(w, "a single recommended option");
}, 60000);

test("a resume refused for the autonomy policy leaves the pass offered", async () => {
  const { w } = fixture(
    "pickup",
    false,
    "Recommended option: take the narrow scope.\nQuestion: Which scope should #12 take?",
  );
  await refusedOnce(w, "human-decision class", false);
}, 60000);

test("a resume of a pass that framed a decision for a person is refused once", async () => {
  const { w } = fixture("pickup");
  const framed = framedResultOf(
    JSON.stringify({
      schema: "parked-decision/v1",
      class: "scope",
      call: {
        id: "a",
        question: "Which cache key should this routine check use?",
        options: [
          { id: "a", name: "Reuse", summary: "Reuse the key.", pay: ["none"] },
          {
            id: "b",
            name: "Wait",
            summary: "Wait for a person.",
            pay: ["a delay"],
          },
        ],
        recommended: "a",
        why: "The existing key already covers the check.",
      },
      steps: [],
      alreadyDone: "Nothing was changed.",
    }),
    new Date().toISOString(),
  );
  expect(framed.ok).toBe(true);
  if (!framed.ok) return;
  expect(
    recordResult(
      OLD,
      "failed",
      dispatchState(w),
      null,
      null,
      undefined,
      framed.value,
    ),
  ).toBe(true);
  await refusedOnce(w, "framed a decision");
}, 60000);
