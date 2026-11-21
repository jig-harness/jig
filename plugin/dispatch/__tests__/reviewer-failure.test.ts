import { afterEach, expect, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { DriveEvent } from "../../skills/drive-pr/scripts/lib/state/events.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { dispatchSection } from "../lib/section.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  BASE_SHA,
  HEAD_SHA,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { notifyWrites, withOrigin } from "./pickup-fixtures.ts";

const BRANCH = "feature/reviewer-wait";
const REVIEWER = "example-review";
const EXIT = DRIVE_EXIT.REVIEWER_FAILED;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function failure(at: string, reviewerHead = HEAD_SHA): DriveEvent {
  return {
    kind: "stop",
    cause: String(EXIT),
    round: 1,
    at,
    reviewerHead,
    reviewerApp: REVIEWER,
  };
}

const PRIOR = failure("2026-10-30T20:00:00.000Z", BASE_SHA);
const FIRST = failure("2026-10-30T21:00:00.000Z");
const SECOND = failure("2026-10-30T22:00:00.000Z");

function stopped(
  w: World,
  events: DriveEvent[],
  reviews: unknown[] = [],
): void {
  w.setComments(7, [
    ledgerComment(
      701,
      stoppedLedger(7, EXIT, { generation: events.length + 3, events }),
    ),
    ...reviews,
  ]);
}

function fixture(events: DriveEvent[]): World {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
review:
  reviewer_app: ${REVIEWER}
dispatch:
  reviewer_failures_before_escalation: 2
  renotify_after: 1s
`,
  );
  withOrigin(w);
  w.setPrs("open", [openPr(7, BRANCH)]);
  stopped(w, events);
  w.setBaseHead(HEAD_SHA);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: BRANCH, linkedPR: 7, path: ws }]);
  writeFileSync(join(w.dir, "drive-exit"), String(EXIT));
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  return w;
}

async function tick(w: World): Promise<TickReceipt["repos"][number]> {
  const result = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(result, 0);
  const receipt = JSON.parse(result.stdout) as TickReceipt;
  expect(receipt.repos).toHaveLength(1);
  const [repo] = receipt.repos;
  assert.ok(repo, "the tick did not report the repository");
  return repo;
}

async function rearmed(w: World): Promise<void> {
  const launched = (await tick(w)).launches?.[0];
  expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
  await waitFor("the re-armed drive to record its exit", () =>
    exitWritten(w, launched?.record ?? ""),
  );
}

function sticky(sha: string, at: string) {
  return {
    id: 702,
    body: `<!-- ai-code-review -->\n<!-- ai-reviewed-sha: ${sha} -->`,
    user: { login: `${REVIEWER}[bot]` },
    author_association: "NONE",
    created_at: at,
    updated_at: at,
  };
}

it("escalates reviewer failure once at the configured same-head threshold and resumes only after fresh review evidence", async () => {
  const w = fixture([PRIOR, FIRST]);
  await rearmed(w);

  stopped(w, [PRIOR, FIRST, SECOND], [sticky(BASE_SHA, FIRST.at)]);
  const held = await tick(w);
  expect(held.launches).toEqual([]);
  expect(held.notifications).toMatchObject([
    { cause: "needs-person", outcome: "sent" },
  ]);
  expect(
    held.actions.find((a) => a.stage === "notify")?.notice?.text,
  ).toContain(`${REVIEWER} failed 2 times on ${HEAD_SHA}`);

  const repeat = await tick(w);
  expect(repeat.launches).toEqual([]);
  expect(repeat.notifications).toMatchObject([
    { cause: "needs-person", outcome: "suppressed" },
  ]);
  expect(notifyWrites(w)).toHaveLength(1);

  // A review posted as the drive stopped still settles the hold.
  stopped(w, [PRIOR, FIRST, SECOND], [sticky(HEAD_SHA, SECOND.at)]);
  await rearmed(w);
  expect(notifyWrites(w)).toHaveLength(1);
}, 120_000);

it("a new head lifts the reviewer hold", async () => {
  const w = fixture([FIRST, SECOND]);
  const held = await tick(w);
  expect(held.launches).toEqual([]);
  w.setPrs("open", [openPr(7, BRANCH, { headRefOid: BASE_SHA })]);
  w.setBaseHead(BASE_SHA);
  await rearmed(w);
}, 120_000);

it("uses the currently configured reviewer to release an older reviewer failure", async () => {
  const w = fixture([FIRST, SECOND]);
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\nreview:\n  reviewer_app: replacement-review\ndispatch:\n  reviewer_failures_before_escalation: 2\n  renotify_after: 1s\n`,
  );
  stopped(
    w,
    [FIRST, SECOND],
    [
      {
        id: 702,
        body: `<!-- ai-code-review -->\n<!-- ai-reviewed-sha: ${HEAD_SHA} -->`,
        user: { login: "replacement-review[bot]" },
        author_association: "NONE",
        created_at: SECOND.at,
        updated_at: SECOND.at,
      },
    ],
  );
  await rearmed(w);
}, 120_000);

it("uses configured bot evidence when the current reviewer has no app", async () => {
  const w = fixture([FIRST, SECOND]);
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\nreview:\n  reviewer_check_pattern: "^Replacement review$"\n  bots: ["replacement-review[bot]"]\ndispatch:\n  reviewer_failures_before_escalation: 2\n  renotify_after: 1s\n`,
  );
  stopped(
    w,
    [FIRST, SECOND],
    [
      {
        id: 702,
        body: `<!-- ai-code-review -->\n<!-- ai-reviewed-sha: ${HEAD_SHA} -->`,
        user: { login: "replacement-review[bot]" },
        author_association: "NONE",
        created_at: SECOND.at,
        updated_at: SECOND.at,
      },
    ],
  );
  await rearmed(w);
}, 120_000);

it("keeps reviewer evidence configured through its bot list", async () => {
  const w = fixture([FIRST, SECOND]);
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\nreview:\n  bots: ["replacement-review[bot]"]\ndispatch:\n  reviewer_failures_before_escalation: 2\n  renotify_after: 1s\n`,
  );
  stopped(
    w,
    [FIRST, SECOND],
    [
      {
        id: 702,
        body: `<!-- ai-code-review -->\n<!-- ai-reviewed-sha: ${HEAD_SHA} -->`,
        user: { login: "replacement-review[bot]" },
        author_association: "NONE",
        created_at: SECOND.at,
        updated_at: SECOND.at,
      },
    ],
  );
  await rearmed(w);
}, 120_000);

it("releases an old reviewer-failure hold when reviewer evidence is no longer configured", async () => {
  const w = fixture([FIRST, SECOND]);
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  reviewer_failures_before_escalation: 2\n  renotify_after: 1s\n`,
  );
  stopped(w, [FIRST, SECOND]);
  await rearmed(w);
}, 120_000);

it("treats null reviewer settings as absent", async () => {
  const w = fixture([FIRST, SECOND]);
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\nreview:\n  reviewer_app: null\n  reviewer_check_pattern: null\ndispatch:\n  reviewer_failures_before_escalation: 2\n  renotify_after: 1s\n`,
  );
  stopped(w, [FIRST, SECOND]);
  await rearmed(w);
}, 120_000);

it("keeps a reviewer-failure hold when a reviewer setting is malformed", async () => {
  const w = fixture([FIRST, SECOND]);
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\nreview:\n  reviewer_app: 123\ndispatch:\n  reviewer_failures_before_escalation: 2\n  renotify_after: 1s\n`,
  );
  stopped(w, [FIRST, SECOND]);

  const held = await tick(w);
  expect(held.launches).toEqual([]);
  expect(held.notifications).toMatchObject([
    { cause: "needs-person", outcome: "sent" },
  ]);
}, 120_000);

it("does not release a malformed reviewer setting from bot evidence", async () => {
  const w = fixture([FIRST, SECOND]);
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\nreview:\n  reviewer_app: 123\n  bots: ["replacement-review[bot]"]\ndispatch:\n  reviewer_failures_before_escalation: 2\n  renotify_after: 1s\n`,
  );
  stopped(
    w,
    [FIRST, SECOND],
    [
      {
        id: 702,
        body: `<!-- ai-code-review -->\n<!-- ai-reviewed-sha: ${HEAD_SHA} -->`,
        user: { login: "replacement-review[bot]" },
        author_association: "NONE",
        created_at: SECOND.at,
        updated_at: SECOND.at,
      },
    ],
  );

  const held = await tick(w);
  expect(held.launches).toEqual([]);
  expect(held.notifications).toMatchObject([
    { cause: "needs-person", outcome: "sent" },
  ]);
}, 120_000);

it("keeps a reviewer-failure hold when the configured check pattern is invalid", async () => {
  const w = fixture([FIRST, SECOND]);
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\nreview:\n  reviewer_app: ${REVIEWER}\n  reviewer_check_pattern: "["\ndispatch:\n  reviewer_failures_before_escalation: 2\n  renotify_after: 1s\n`,
  );
  stopped(w, [FIRST, SECOND], [sticky(HEAD_SHA, SECOND.at)]);

  const held = await tick(w);
  expect(held.launches).toEqual([]);
  expect(held.notifications).toMatchObject([
    { cause: "needs-person", outcome: "sent" },
  ]);
}, 120_000);

it("validates the configured threshold and applies the default", () => {
  expect(dispatchSection({})).toMatchObject({
    ok: true,
    value: { reviewerFailures: { threshold: 3 } },
  });
  expect(
    dispatchSection({ dispatch: { reviewer_failures_before_escalation: 0 } }),
  ).toMatchObject({ ok: false });
});

it("keeps a reviewer-failure hold when its evidence contract is malformed", async () => {
  const w = fixture([FIRST, SECOND]);
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\nreview:\n  reviewer_app: ${REVIEWER}\n  reviewer_evidence: typo\n  sticky_marker: 123\ndispatch:\n  reviewer_failures_before_escalation: 2\n  renotify_after: 1s\n`,
  );
  stopped(w, [FIRST, SECOND], [sticky(HEAD_SHA, SECOND.at)]);

  const held = await tick(w);
  expect(held.launches).toEqual([]);
  expect(held.notifications).toMatchObject([
    { cause: "needs-person", outcome: "sent" },
  ]);
}, 120_000);
