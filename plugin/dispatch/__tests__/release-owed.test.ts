/** The follow-up's release handoff and the release's counted answer, through dispatch. */
import { afterEach, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectSpawnExit,
  expectSpawnExitNot,
} from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { releasingCommit as inspectRelease } from "../../skills/changelog/scripts/releasing-commit.ts";
import { localWriter } from "../../shared/records/writer.ts";
import { markerRun, tickMarker } from "../lib/followup-marker.ts";
import { hostOf } from "../lib/shared-launches.ts";
import { readOutcomes } from "../lib/followup-outcomes.ts";
import { readLine } from "../lib/line-store.ts";
import { recordExit, type LaunchRecord } from "../lib/launches.ts";
import type { LineNeed } from "../lib/dashboard-contract.ts";
import { currentIso } from "../../shared/time.ts";
import { mergedPr, SLUG, type World, world } from "./fixtures.ts";
import { FOLLOWUP_CONFIG, followupWorkspace } from "./followup-fixtures.ts";
import {
  account,
  dispatchState,
  earlierRecord,
  machineFile,
} from "./launch-fixtures.ts";
import { applyTick } from "./pickup-fixtures.ts";

const TAG = "v1.2.3";
const ITEM = "#42";

const active: World[] = [];
afterEach(() => {
  for (const w of active.splice(0)) w.close();
});

function fixture(): World {
  const w = world();
  active.push(w);
  followupWorkspace(w);
  mkdirSync(join(w.repo, ".config"), { recursive: true });
  writeFileSync(join(w.repo, ".config/jig.yaml"), FOLLOWUP_CONFIG);
  w.setPrs("merged", [
    mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z"),
    mergedPr(10, "feature/10-done", "2026-10-31T12:01:00Z"),
  ]);
  w.setComments(10, []);
  return w;
}

function pass(
  w: World,
  pr: number,
  fields: Partial<LaunchRecord> = {},
): LaunchRecord {
  return earlierRecord(w, {
    id: `20261101T120000Z-000000${pr === 9 ? "09" : "10"}`,
    account: "a",
    action: "followup",
    pr,
    repo: SLUG,
    createdAt: "2026-11-01T12:00:00.000Z",
    ...fields,
  });
}

async function release(
  w: World,
  record: LaunchRecord,
  item?: string,
  state?: string,
): Promise<unknown> {
  const args = ["release-owed", record.id, record.token, TAG];
  if (item !== undefined) args.push(item);
  if (state !== undefined) args.push("--state", state);
  const result = await w.dispatch(args);
  expectSpawnExit(result, 0);
  return JSON.parse(result.stdout);
}

async function endPass(w: World, record: LaunchRecord): Promise<void> {
  expectSpawnExit(
    await w.dispatch(["result", record.id, record.token, "done"]),
    0,
  );
  recordExit(
    record.id,
    { at: currentIso(), code: 0, signal: null },
    dispatchState(w),
  );
}

function releaseCards(w: World): LineNeed[] {
  const line = readLine(dispatchState(w));
  expect(line.ok).toBe(true);
  return line.ok
    ? (line.value?.needs.filter((need) => need.cause === "release-owed") ?? [])
    : [];
}

it("keeps one release need while both merged pull requests' follow-ups finish", async () => {
  const w = fixture();
  const first = pass(w, 9);
  const second = pass(w, 10);
  expect(await release(w, first)).toEqual({ status: "reserved" });
  expect(await release(w, second)).toEqual({ status: "reserved-elsewhere" });
  expect(await release(w, first, ITEM)).toEqual({
    status: "recorded",
    item: ITEM,
  });
  await endPass(w, first);
  expect(await release(w, second)).toEqual({ status: "recorded", item: ITEM });
  await endPass(w, second);
  await applyTick(w, false);
  expect(
    [...readOutcomes(SLUG, dispatchState(w)).values()]
      .sort((a, b) => a.pr - b.pr)
      .map(({ pr, outcome }) => [pr, outcome]),
  ).toEqual([
    [9, "done"],
    [10, "done"],
  ]);
  const [need] = releaseCards(w);
  expect(releaseCards(w)).toHaveLength(1);
  expect(need).toMatchObject({ target: ITEM, act: "Authorize" });
  expect(need?.decisions[0]).toMatchObject({
    key: "release",
    decisionClass: "release",
    answer: { address: `pickup@${SLUG}#42` },
    options: [
      { name: "Re-run the failed gates" },
      { name: "Investigate" },
      { name: "Tag it by hand" },
    ],
  });
});

it("recommends tagging by hand for a release its follow-up recorded with every check passed", async () => {
  const w = fixture();
  const first = pass(w, 9);
  expect(await release(w, first, undefined, "ready")).toEqual({
    status: "reserved",
  });
  expect(await release(w, first, ITEM, "ready")).toEqual({
    status: "recorded",
    item: ITEM,
  });
  await endPass(w, first);
  await applyTick(w, false);
  const [need] = releaseCards(w);
  expect(need?.reason).toContain("Every required check passed");
  const [decision] = need?.decisions ?? [];
  expect(decision?.options?.map((o) => o.name)).toEqual([
    "Investigate",
    "Tag it by hand",
  ]);
  expect(decision?.options?.find((o) => o.recommended)?.name).toBe(
    "Tag it by hand",
  );
});

it("refuses a tag-plan state a release is never owed under", async () => {
  const w = fixture();
  const record = pass(w, 9);
  const result = await w.dispatch([
    "release-owed",
    record.id,
    record.token,
    TAG,
    "--state",
    "pending",
  ]);
  expectSpawnExitNot(result, 0);
});

function git(w: World, ...args: string[]): string {
  const out = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      ...args,
    ],
    {
      cwd: w.repo,
      env: w.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expectSpawnExit(out, 0);
  return out.stdout.toString().trim();
}

function releasingCommit(w: World): string {
  const config = `${FOLLOWUP_CONFIG}repository:\n  base_branch: main\nci:\n  required_checks: [Gates]\nchangelog:\n  file: CHANGELOG.md\n  format: keep-a-changelog\n  version: { tags: true }\n`;
  w.setConfig(config);
  mkdirSync(join(w.repo, ".config"), { recursive: true });
  writeFileSync(join(w.repo, ".config/jig.yaml"), config);
  writeFileSync(
    join(w.repo, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n",
  );
  git(w, "add", ".config/jig.yaml", "CHANGELOG.md");
  git(w, "commit", "-m", "Configure release gates");
  writeFileSync(
    join(w.repo, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-11-01\n",
  );
  git(w, "add", "CHANGELOG.md");
  git(w, "commit", "-m", "Release 1.2.3");
  git(w, "push", "origin", "HEAD:main");
  return git(w, "rev-parse", "HEAD");
}

it("requests only failed gates on the releasing commit once and records the answer", async () => {
  const w = fixture();
  const sha = releasingCommit(w);
  expect(inspectRelease(w.repo, TAG)).toEqual({
    sha,
    branch: "main",
    checks: ["Gates"],
  });
  const record = pass(w, 9);
  await release(w, record);
  await release(w, record, ITEM);
  await endPass(w, record);
  const check = { head_sha: sha, status: "completed", conclusion: "failure" };
  writeFileSync(
    join(w.dir, "release-checks.json"),
    JSON.stringify({
      total_count: 2,
      check_runs: [
        {
          ...check,
          conclusion: "skipped",
          name: "Gates",
          check_suite: { id: 20 },
        },
        { ...check, name: "Advisory", check_suite: { id: 21 } },
      ],
    }),
  );
  writeFileSync(
    join(w.dir, "release-runs.json"),
    JSON.stringify({
      total_count: 2,
      workflow_runs: [
        { id: 30, head_sha: sha, conclusion: "failure", check_suite_id: 20 },
        { id: 31, head_sha: sha, conclusion: "failure", check_suite_id: 21 },
      ],
    }),
  );
  w.setComments(42, []);
  await applyTick(w, false);
  const digest = releaseCards(w)[0]?.decisions[0]?.digest;
  expect(digest).toBeDefined();
  w.setComments(42, [
    forgeComment(
      111,
      `answer release: approve [${digest}]`,
      "maintainer",
      "OWNER",
    ),
  ]);
  await applyTick(w, false);
  expect(releaseCards(w)[0]?.decisions[0]?.acted).toMatchObject({
    option: "Re-run the failed gates",
    outcome: "done",
    detail: "Requested failed jobs again in workflow runs 30",
  });
  await applyTick(w, false);
  const writes = readFileSync(join(w.dir, "gh-calls.log"), "utf8")
    .split("\n")
    .filter((line) => line.includes("rerun-failed-jobs"));
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain("/actions/runs/30/rerun-failed-jobs");
});

it("hands worker follow-ups' release to a notification-only owner's tracker once", async () => {
  const remote = fixture();
  const owner = fixture();
  const scope = { followup_since: "2026-10-30T00:00:00Z" };
  owner.setConfig(
    FOLLOWUP_CONFIG.split("dispatch:")[0] +
      "changelog:\n  file: CHANGELOG.md\n",
  );
  machineFile(
    owner,
    [account(owner, "a", "a@example.com")],
    {},
    ["notify"],
    scope,
  );
  machineFile(
    remote,
    [account(remote, "a", "a@example.com")],
    {},
    ["followup", "notify"],
    { ...scope, owner: false },
  );
  const merged = [
    mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z"),
    mergedPr(10, "feature/10-done", "2026-10-31T12:01:00Z"),
  ];
  remote.setPrs("merged", merged);
  owner.setPrs("merged", merged);
  const runs = [
    pass(remote, 9, { followupOwner: false, marker: 101 }),
    pass(remote, 10, { followupOwner: false, marker: 102 }),
  ];
  for (const { id, pr, marker } of runs) {
    if (pr === null || marker === null) continue;
    remote.setComments(pr, [
      forgeComment(
        marker,
        tickMarker(id, {
          pr,
          writer: localWriter("forge", "drive-bot"),
          host: hostOf(dispatchState(remote)),
          owner: false,
        }),
        "drive-bot",
        "MEMBER",
      ),
    ]);
  }
  for (const run of runs)
    expect(await release(remote, run)).toEqual({ status: "delegated" });
  for (const run of runs) await endPass(remote, run);
  await applyTick(remote, false);
  expect(remote.trackerOps()).not.toContain("TrackerCreate");
  expect(releaseCards(remote)).toHaveLength(0);
  for (const pr of [9, 10]) {
    const comments = JSON.parse(
      readFileSync(join(remote.dir, `comments-${pr}.json`), "utf8"),
    ) as Array<{ body: string }>;
    expect(markerRun(comments[0]?.body ?? "", pr)).toMatchObject({
      kind: "tick",
      owner: false,
      outcome: "done",
      releaseTags: [TAG],
    });
    owner.setComments(pr, comments);
  }
  owner.setComments(42, []);
  const received = await applyTick(owner, false);
  expect(received.repos[0]?.unplaced).toEqual([]);
  expect(received.repos[0]?.launches).toEqual([]);
  expect(
    owner.trackerOps().filter((op) => op === "TrackerCreate"),
  ).toHaveLength(1);
  expect(releaseCards(owner)).toMatchObject([
    { target: ITEM, act: "Authorize" },
  ]);
  await applyTick(owner, false);
  expect(
    owner.trackerOps().filter((op) => op === "TrackerCreate"),
  ).toHaveLength(1);
  expect(releaseCards(owner)).toHaveLength(1);
});
