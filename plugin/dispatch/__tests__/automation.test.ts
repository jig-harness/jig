/**
 * jig dispatch with the marker labels and automation pull requests, end to
 * end through the fake forge: one `--apply` tick puts the manual-operations
 * label on a pull request whose description owes a step and takes a
 * hand-added one off a pull request that owes none, puts `automation` on a
 * bot's pull request, and labels a merge whose follow-up failed
 * `followup-failed`. The adoption rule drives an automation pull request
 * only while it needs work (a failing check, a conflict, an unresolved
 * review thread), unless a person's `drive` label asks for it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  FAILING,
  labeled,
  ledgerComment,
  mergedPr,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  driveRuns,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns } from "./pickup-fixtures.ts";

const config = (dispatch: string) => `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
${dispatch}
`;

const LABELS = config("  labels: { enabled: true }");
const ADOPT = config(
  '  labels: { enabled: true }\n  adopt:\n    enabled: true\n    authors: [drive-bot, "ops-bot[bot]"]',
);
const FOLLOWUP = config(
  "  labels: { enabled: true }\n  followup_command: /followup",
);

const OWES = "## Out-of-tree follow-ups\n\n- [ ] Set the staging secret\n";
const NONE =
  "## Out-of-tree follow-ups\n\n_None — merging this completes it._\n";
/** Checks and review threads read in full, with nothing wrong. */
const HEALTHY = { statusCheckRollup: [], unresolvedThreads: 0 };
const recent = () => new Date(Date.now() - 3_600_000).toISOString();

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

function fixture(yaml: string, stages = ["rearm"], extra = {}): World {
  const w = world();
  current = w;
  w.setConfig(yaml);
  machineFile(w, [account(w, "a", "a@example.com")], {}, stages, extra);
  return w;
}

/** An open pull request by `login` (a bot when its login is an app's), updated an hour ago, with `extra` fields. */
function by(number: number, login: string, extra: object = {}) {
  return {
    ...openPr(number, `feature/${number}`),
    author: { login, is_bot: login.startsWith("app/") },
    isDraft: false,
    updatedAt: recent(),
    ...extra,
  };
}

async function tick(w: World, args: string[] = []): Promise<TickReceipt> {
  const r = await w.dispatch([...args, "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

/** The label names PR `n` carries now in the `state` listing the fake forge keeps. */
function labelsOf(w: World, n: number, state = "open"): string[] {
  const prs = JSON.parse(
    readFileSync(join(w.dir, `prs-${state}.json`), "utf8"),
  ) as Array<{ number: number; labels?: Array<{ name: string }> }>;
  return (prs.find((p) => p.number === n)?.labels ?? []).map((l) => l.name);
}

const rearms = (r: TickReceipt) =>
  (r.repos[0]?.actions ?? [])
    .filter((a) => a.stage === "rearm")
    .map((a) => a.target);

describe("jig dispatch keeps the marker labels", () => {
  it("labels owed steps and a bot's pull request at one tick, and takes a hand-added owed-steps label off", async () => {
    const w = fixture(LABELS);
    w.setPrs("open", [
      by(1, "maintainer", { body: OWES }),
      labeled(by(2, "maintainer", { body: NONE }), "manual-ops"),
      by(3, "app/regen-bot"),
      labeled(by(4, "app/regen-bot"), "automation:docs-sync"),
      by(5, "maintainer"),
    ]);
    for (const n of [1, 2, 3, 4, 5]) w.setComments(n, []);

    await tick(w, ["--apply"]);
    expect(labelsOf(w, 1)).toEqual(["manual-ops"]);
    expect(labelsOf(w, 2)).toEqual([]);
    expect(labelsOf(w, 3)).toEqual(["automation"]);
    expect(labelsOf(w, 4)).toEqual(["automation:docs-sync"]);
    expect(labelsOf(w, 5)).toEqual([]);

    // A person adds the label back by hand: the next tick corrects it again.
    w.setPrs("open", [
      labeled(by(1, "maintainer", { body: OWES }), "manual-ops"),
      labeled(by(2, "maintainer", { body: NONE }), "manual-ops"),
    ]);
    const again = await tick(w, ["--apply"]);
    expect(labelsOf(w, 2)).toEqual([]);
    expect(again.repos[0]?.labels?.writes).toEqual([
      expect.objectContaining({ target: "PR #2", remove: ["manual-ops"] }),
    ]);
  }, 60_000);

  it("labels a merge whose follow-up failed followup-failed, for a person", async () => {
    const w = fixture(FOLLOWUP, ["followup"], {
      followup_since: "2026-10-30T00:00:00Z",
    });
    const head = "feature/9-done";
    w.setPrs("merged", [mergedPr(9, head, "2026-10-31T12:00:00Z")]);
    w.setComments(9, []);
    const ws = join(w.root, "ws-9");
    mkdirSync(ws, { recursive: true });
    w.setWorkspaces([{ branch: head, linkedPR: 9, path: ws }]);

    const first = await applyTick(w, false);
    const id = String(first.repos[0]?.launches[0]?.record);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    writeFileSync(
      join(w.dir, "claude-said"),
      "Question: which environment takes the secret?\n",
    );
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the exit", () => exitWritten(w, id));
    w.setWorkspaces([]);

    const after = await applyTick(w, false);
    expect(after.repos[0]?.actions).toContainEqual(
      expect.objectContaining({ target: "PR #9", cause: "followup-failed" }),
    );
    expect(labelsOf(w, 9, "merged")).toEqual(["jig:followup-failed"]);
  }, 90_000);
});

describe("jig dispatch drives an automation pull request only while it needs work", () => {
  it("adopts one whose check fails, which conflicts or which has an unresolved thread, and leaves a healthy one", async () => {
    const w = fixture(ADOPT);
    const sync = (n: number, extra: object = {}) =>
      labeled(by(n, "drive-bot", extra), "automation:docs-sync");
    w.setPrs("open", [
      sync(20, HEALTHY),
      sync(21, FAILING),
      sync(22, { mergeable: "CONFLICTING" }),
      // A bot the rule names is the host's own identity: adopted as any own pull request.
      by(23, "app/ops-bot"),
      sync(24, HEALTHY),
      // A bot the rule does not name: only a person's drive label drives it.
      by(25, "app/regen-bot", FAILING),
      labeled(by(26, "app/regen-bot"), "jig:drive"),
      labeled(sync(27, FAILING), "jig:hold"),
      by(28, "drive-bot", HEALTHY),
      labeled(by(29, "app/ops-bot", HEALTHY), "automation:docs-sync"),
      // A run cancelled on a superseded head is no failure.
      sync(30, {
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            status: "COMPLETED",
            conclusion: "CANCELLED",
          },
        ],
      }),
    ]);
    const all = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
    for (const n of all) w.setComments(n, []);
    writeFileSync(join(w.dir, "threads-24"), "2");

    const r = await tick(w);
    expect(rearms(r)).toEqual([
      "PR #21",
      "PR #22",
      "PR #23",
      "PR #24",
      "PR #26",
      "PR #28",
    ]);
    const why = (n: number) =>
      String(
        r.repos[0]?.actions.find((a) => a.target === `PR #${n}`)?.evidence
          .adopted,
      );
    expect(why(21)).toContain("a check on its head fails");
    expect(why(22)).toContain("it conflicts with its base");
    expect(why(24)).toContain("2 review threads unresolved");
  }, 60_000);

  it("re-drives a converged automation pull request whose head moved only while it needs work, or on a person's rearm", async () => {
    const w = fixture(LABELS);
    const sync = (n: number, extra: object = {}) =>
      labeled(by(n, "drive-bot", extra), "automation:docs-sync");
    w.setPrs("open", [
      sync(40, HEALTHY),
      sync(41, FAILING),
      labeled(sync(42), "jig:rearm"),
      by(43, "drive-bot"),
    ]);
    // Each converged at a head its pull request has since moved past.
    for (const n of [40, 41, 42, 43])
      w.setComments(n, [
        ledgerComment(
          n * 100 + 1,
          stoppedLedger(n, 0, { verifiedSha: "b".repeat(40) }),
        ),
      ]);

    const r = await tick(w);
    expect(rearms(r)).toEqual(["PR #41", "PR #42", "PR #43"]);
    expect(r.repos[0]?.quiet).toContainEqual(
      expect.objectContaining({
        target: "PR #40",
        class: "stale",
        why: expect.stringContaining(
          "an automation pull request that needs no work",
        ),
      }),
    );
  }, 60_000);

  it("launches on observed trouble without a thread count", async () => {
    const w = fixture(ADOPT);
    w.setPrs("open", [
      labeled(by(24, "drive-bot", FAILING), "automation:docs-sync"),
    ]);
    w.setComments(24, []);
    const ws = join(w.root, "ws-24");
    mkdirSync(ws, { recursive: true });
    w.setWorkspaces([{ branch: "feature/24", linkedPR: 24, path: ws }]);

    const [launched] = (await tick(w, ["--apply"])).repos[0]?.launches ?? [];
    expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
  }, 60_000);

  it("launches nothing, and says why, when the fresh read cannot count the threads", async () => {
    const w = fixture(ADOPT);
    w.setPrs("open", [labeled(by(24, "drive-bot"), "automation:docs-sync")]);
    w.setComments(24, []);
    const ws = join(w.root, "ws-24");
    mkdirSync(ws, { recursive: true });
    w.setWorkspaces([{ branch: "feature/24", linkedPR: 24, path: ws }]);

    const [held] = (await tick(w, ["--apply"])).repos[0]?.launches ?? [];
    expect(held).toMatchObject({ action: "rearm", outcome: "waits" });
    expect(held?.detail).toContain(
      "its ledger cannot be read again: its unresolved review threads do not read",
    );
    expect(driveRuns(w)).toHaveLength(0);
  }, 60_000);

  it("launches the drive on an unresolved thread, which its fresh read finds again", async () => {
    const w = fixture(ADOPT);
    w.setPrs("open", [labeled(by(24, "drive-bot"), "automation:docs-sync")]);
    w.setComments(24, []);
    writeFileSync(join(w.dir, "threads-24"), "1");
    const ws = join(w.root, "ws-24");
    mkdirSync(ws, { recursive: true });
    w.setWorkspaces([{ branch: "feature/24", linkedPR: 24, path: ws }]);

    const [launched] = (await tick(w, ["--apply"])).repos[0]?.launches ?? [];
    expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
    await waitFor("the exit", () => exitWritten(w, launched?.record ?? ""));
    expect(driveRuns(w)).toHaveLength(1);
  }, 90_000);
});

describe("an automation pull request that needs no work", () => {
  const bot = { login: "renovate[bot]", bot: true };

  it("is idle only when every fact was read", async () => {
    const { idleAutomation } = await import("../lib/automation.ts");
    expect(
      idleAutomation(
        { author: bot, failingChecks: false, unresolvedThreads: 0 },
        [],
      ),
    ).toEqual({ automationIdle: true });
    expect(idleAutomation({ author: bot, unresolvedThreads: 0 }, [])).toEqual(
      {},
    );
    expect(idleAutomation({ author: bot, failingChecks: false }, [])).toEqual(
      {},
    );
    expect(idleAutomation({ author: bot, failingChecks: true }, [])).toEqual(
      {},
    );
  });
});
