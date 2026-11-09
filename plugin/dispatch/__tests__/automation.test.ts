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
  mergedPr,
  openPr,
  SLUG,
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
  '  labels: { enabled: true }\n  adopt:\n    enabled: true\n    authors: [drive-bot, "regen-bot[bot]"]',
);
const FOLLOWUP = config(
  "  labels: { enabled: true }\n  followup_command: /followup",
);

const OWES = "## Out-of-tree follow-ups\n\n- [ ] Set the staging secret\n";
const NONE =
  "## Out-of-tree follow-ups\n\n_None — merging this completes it._\n";
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
    w.setPrs("open", [
      by(20, "app/regen-bot"),
      by(21, "app/regen-bot", FAILING),
      by(22, "app/regen-bot", { mergeable: "CONFLICTING" }),
      labeled(by(23, "drive-bot"), "automation:docs-sync"),
      labeled(by(24, "drive-bot"), "automation:docs-sync"),
      labeled(by(25, "app/regen-bot"), "jig:drive"),
      labeled(by(26, "app/regen-bot", FAILING), "jig:hold"),
      by(27, "drive-bot"),
    ]);
    for (const n of [20, 21, 22, 23, 24, 25, 26, 27]) w.setComments(n, []);
    writeFileSync(join(w.dir, "threads-24"), "2");

    const r = await tick(w);
    expect(rearms(r)).toEqual([
      "PR #21",
      "PR #22",
      "PR #24",
      "PR #25",
      "PR #27",
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
