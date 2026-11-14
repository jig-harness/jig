/**
 * jig dispatch with dispatch labels on: each managed pull request's state
 * label is set from its ledger, a person's `drive` label arms a pull
 * request with no ledger once and is replaced by the state label once the
 * ledger exists, a `hold` label keeps every stage off a pull request, and
 * `only_labeled` keeps the tick off the pull requests that carry no label
 * of the set. With the labels off, none is read or written.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { DEFAULT_LABELS, labelSet } from "../lib/labels.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  HEAD_SHA,
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

const JIG = resolve(import.meta.dir, "../../jig.ts");
const ENTRY = resolve(import.meta.dir, "fixtures", "install-labels-entry.ts");

const config = (labels: string) => `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
${labels}
`;

const ON = config("  labels: { enabled: true }");
const ONLY = config("  labels: { enabled: true, only_labeled: true }");
const OFF = config("  stalled_after: 30m");

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A world with `yaml` on the default branch, whose machine file lists the repository with `stages` on account a. */
function fixture(yaml: string, stages: string[] = ["rearm"]): World {
  const w = world();
  current = w;
  w.setConfig(yaml);
  machineFile(w, [account(w, "a", "a@example.com")], {}, stages);
  return w;
}

async function tick(w: World, args = ["--apply"]): Promise<TickReceipt> {
  const r = await w.dispatch([...args, "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

/** A workspace for each of these pull requests, on its head branch `feature/<n>`. */
function workspaces(w: World, ...prs: number[]): void {
  w.setWorkspaces(
    prs.map((n) => {
      const path = join(w.root, `ws-${n}`);
      mkdirSync(path, { recursive: true });
      return { branch: `feature/${n}`, linkedPR: n, path };
    }),
  );
}

/** The label names PR `n` carries now, as the fake forge keeps them. */
function labelsOf(w: World, n: number): string[] {
  const prs = JSON.parse(
    readFileSync(join(w.dir, "prs-open.json"), "utf8"),
  ) as Array<{ number: number; labels?: Array<{ name: string }> }>;
  return (prs.find((p) => p.number === n)?.labels ?? []).map((l) => l.name);
}

/** Every `gh` call the tick made, one line each; `clear` starts the log afresh. */
function ghCalls(w: World, clear = false): string[] {
  const path = join(w.dir, "gh-calls.log");
  const lines = existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n")
    : [];
  if (clear) writeFileSync(path, "");
  return lines.filter((l) => l !== "");
}

const edits = (calls: string[]) =>
  calls.filter((c) => c.startsWith("pr edit "));

const repo = (r: TickReceipt) => r.repos[0];

const converged = (pr: number) =>
  ledgerComment(pr * 100 + 1, stoppedLedger(pr, 0, { verifiedSha: HEAD_SHA }));

describe("jig dispatch keeps each managed pull request's state label current", () => {
  it("puts the ledger's label back after one tick on a pull request whose label was changed by hand, and writes nothing when they agree", async () => {
    const w = fixture(ON);
    // Converged at its head, but a person changed its label to driving.
    w.setPrs("open", [labeled(openPr(7, "feature/7"), "jig:driving", "bug")]);
    w.setComments(7, [converged(7)]);

    const first = await tick(w);
    expect(labelsOf(w, 7)).toEqual(["bug", "jig:converged"]);
    expect(edits(ghCalls(w, true))).toEqual([
      `pr edit 7 --repo ${SLUG} --add-label jig:converged --remove-label jig:driving`,
    ]);
    expect(repo(first)?.labels?.writes).toEqual([
      {
        target: "PR #7",
        add: ["jig:converged"],
        remove: ["jig:driving"],
        outcome: "written",
        detail: "+jig:converged -jig:driving",
      },
    ]);

    const second = await tick(w);
    expect(edits(ghCalls(w))).toEqual([]);
    expect(repo(second)?.labels?.writes).toEqual([]);
    expect(repo(second)?.labels?.states).toEqual([
      { target: "PR #7", state: "converged" },
    ]);
  }, 60_000);

  it("labels a drive armed by hand at the next tick, and reports without writing on a run without --apply", async () => {
    const w = fixture(ON);
    w.setPrs("open", [openPr(7, "feature/7")]);
    w.setComments(7, [converged(7)]);

    const report = await tick(w, []);
    expect(edits(ghCalls(w, true))).toEqual([]);
    expect(repo(report)?.labels?.writes).toMatchObject([
      { target: "PR #7", add: ["jig:converged"], outcome: "would" },
    ]);

    await tick(w);
    expect(labelsOf(w, 7)).toEqual(["jig:converged"]);
  }, 60_000);

  it("reports a write the forge refuses, and the tick does not fail", async () => {
    const w = fixture(ON);
    w.setPrs("open", [openPr(7, "feature/7")]);
    w.setComments(7, [converged(7)]);
    writeFileSync(join(w.dir, "label-edit-fail"), "");

    const r = await tick(w);
    expect(r.exitStatus).toBe(0);
    expect(repo(r)?.labels?.writes).toMatchObject([
      { target: "PR #7", outcome: "failed" },
    ]);
    expect(repo(r)?.labels?.writes[0]?.detail).toContain("HTTP 403");
    expect(labelsOf(w, 7)).toEqual([]);
  }, 60_000);
});

describe("jig dispatch reads a person's drive and hold labels", () => {
  it("arms a pull request with no ledger once across three ticks, and replaces its drive label with the state label once the ledger exists", async () => {
    const w = fixture(ON);
    w.setPrs("open", [labeled(openPr(8, "feature/8"), "jig:drive")]);
    workspaces(w, 8);

    const [launched] = repo(await tick(w))?.launches ?? [];
    expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
    await waitFor("the exit", () => exitWritten(w, launched?.record ?? ""));
    expect(labelsOf(w, 8)).toEqual(["jig:drive"]);

    // The drive wrote its ledger: the next tick labels it and arms nothing.
    w.setComments(8, [converged(8)]);
    ghCalls(w, true);
    const second = await tick(w);
    expect(repo(second)?.launches).toEqual([]);
    expect(edits(ghCalls(w, true))).toEqual([
      `pr edit 8 --repo ${SLUG} --add-label jig:converged --remove-label jig:drive`,
    ]);
    expect(labelsOf(w, 8)).toEqual(["jig:converged"]);

    const third = await tick(w);
    expect(repo(third)?.launches).toEqual([]);
    expect(edits(ghCalls(w))).toEqual([]);
    expect(driveRuns(w)).toHaveLength(1);
  }, 90_000);

  it("does not arm again at the same head when the arm left no ledger", async () => {
    const w = fixture(ON);
    w.setPrs("open", [labeled(openPr(8, "feature/8"), "jig:drive")]);
    workspaces(w, 8);
    const [launched] = repo(await tick(w))?.launches ?? [];
    await waitFor("the exit", () => exitWritten(w, launched?.record ?? ""));

    for (const _ of [2, 3]) {
      const later = await tick(w);
      expect(repo(later)?.launches).toEqual([]);
      expect(repo(later)?.quiet).toContainEqual({
        target: "PR #8",
        class: "unarmed",
        why: `launch record ${launched?.record} armed it at this head and ended 0 without a drive ledger; it is not armed again until its head moves`,
      });
    }
    expect(labelsOf(w, 8)).toEqual(["jig:drive"]);
    expect(driveRuns(w)).toHaveLength(1);
  }, 90_000);

  it("reports a drive label on a pull request that already has a ledger and replaces it with the state label, arming nothing", async () => {
    const w = fixture(ON);
    w.setPrs("open", [labeled(openPr(7, "feature/7"), "jig:drive")]);
    w.setComments(7, [converged(7)]);

    const r = await tick(w);
    expect(repo(r)?.launches).toEqual([]);
    expect(repo(r)?.labels?.commands).toEqual([
      {
        target: "PR #7",
        command: "drive",
        note: "it has a drive ledger (done): nothing is armed for the label, which is replaced by the state label",
      },
    ]);
    expect(labelsOf(w, 7)).toEqual(["jig:converged"]);
    expect(driveRuns(w)).toEqual([]);
  }, 60_000);

  it("keeps a re-armable drive from being re-armed while a hold label is on it, says so, and never removes the label", async () => {
    const w = fixture(ON);
    w.setPrs("open", [labeled(openPr(7, "feature/7"), "jig:hold")]);
    workspaces(w, 7);
    // Stopped 4 (not judgeable yet): re-armable on any account.
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 4))]);

    const r = await tick(w);
    expect(repo(r)?.actions).toEqual([]);
    expect(repo(r)?.launches).toEqual([]);
    expect(repo(r)?.labels?.held).toEqual([
      {
        target: "PR #7",
        stage: "rearm",
        reason:
          "a person's hold label stands the dispatcher down from it; without it the tick would rearm: drive ledger re-armable: stopped 4 (not judgeable yet): re-arm on any account",
      },
    ]);
    expect(repo(r)?.labels?.commands).toContainEqual({
      target: "PR #7",
      command: "hold",
      note: "a person's hold: no stage runs on it while the label is there, and the tick never removes it",
    });
    expect(labelsOf(w, 7)).toEqual(["jig:hold", "jig:driving"]);
    expect(driveRuns(w)).toEqual([]);

    // The person removes it: the next tick re-arms.
    w.setPrs("open", [labeled(openPr(7, "feature/7"), "jig:driving")]);
    const [launched] = repo(await tick(w))?.launches ?? [];
    expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
  }, 60_000);
});

describe("jig dispatch with only_labeled", () => {
  it("never reads or launches an unlabeled pull request with a ledger, and still drives a labeled one", async () => {
    const w = fixture(ONLY);
    w.setPrs("open", [
      openPr(7, "feature/7"),
      labeled(openPr(9, "feature/9"), "jig:driving"),
    ]);
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 4))]);
    w.setComments(9, [ledgerComment(901, stoppedLedger(9, 4))]);
    workspaces(w, 7, 9);

    const r = await tick(w);
    const calls = ghCalls(w);
    expect(calls.filter((c) => c.includes("issues/7/comments"))).toEqual([]);
    expect(calls.filter((c) => c.includes("issues/9/comments"))).not.toEqual(
      [],
    );
    expect(edits(calls)).toEqual([]);
    expect(repo(r)?.launches).toMatchObject([
      { target: "PR #9", outcome: "launched" },
    ]);
    expect(repo(r)?.labels?.unlabeled).toBe(1);
    expect(labelsOf(w, 7)).toEqual([]);
    expect(repo(r)?.inScope).toEqual([9]);
  }, 60_000);

  it("leaves a pull request the listings disagree on unplaced for the tick, and acts once they agree", async () => {
    const w = fixture(
      config(
        "  labels: { enabled: true, only_labeled: true }\n  followup_command: /followup",
      ),
    );
    // Listed open with a label of the set, and merged without one, in the same tick.
    w.setPrs("open", [labeled(openPr(7, "feature/7"), "jig:driving")]);
    w.setComments(7, [converged(7)]);
    const mergedAt = new Date().toISOString();
    w.setPrs("merged", [mergedPr(7, "feature/7", mergedAt)]);
    const args = ["--apply", "--followup-since", "2026-10-01"];

    const disputed = await tick(w, args);
    expect(repo(disputed)?.unplaced).toContainEqual({
      target: "PR #7",
      record: "forge",
      reason:
        "the open and the merged listing disagree on whether it carries a dispatch label, so whether it is in scope cannot be told this tick",
    });
    expect(repo(disputed)?.actions.filter((a) => a.target === "PR #7")).toEqual(
      [],
    );
    expect(repo(disputed)?.labels?.states).toEqual([]);
    expect(edits(ghCalls(w, true))).toEqual([]);
    expect(labelsOf(w, 7)).toEqual(["jig:driving"]);

    // The merge carries the label too: in scope, and its follow-up is wanted.
    w.setPrs("merged", [
      labeled(mergedPr(7, "feature/7", mergedAt), "jig:driving"),
    ]);
    const agreed = await tick(w, args);
    expect(repo(agreed)?.unplaced.map((u) => u.target)).not.toContain("PR #7");
    expect(repo(agreed)?.actions).toContainEqual(
      expect.objectContaining({ target: "PR #7", stage: "followup" }),
    );
  }, 60_000);
});

describe("jig dispatch with the labels off", () => {
  it("reads no label and writes none, whatever the pull requests carry", async () => {
    const w = fixture(OFF);
    w.setPrs("open", [labeled(openPr(7, "feature/7"), "jig:driving")]);
    w.setComments(7, [converged(7)]);

    const r = await tick(w);
    // The repository's query lists the labels before the section that turns them off is read; none is used.
    expect(edits(ghCalls(w))).toEqual([]);
    expect(repo(r)?.labels).toBeUndefined();
    expect(labelsOf(w, 7)).toEqual(["jig:driving"]);
  }, 60_000);

  it("lists the pull requests without their labels when the repository's query does not read", async () => {
    const w = fixture(OFF);
    w.setPrs("open", [labeled(openPr(7, "feature/7"), "jig:driving")]);
    w.setComments(7, [converged(7)]);
    writeFileSync(join(w.dir, "repository-query-fail"), "");

    const r = await tick(w);
    const calls = ghCalls(w);
    const listing = calls.find((c) => c.startsWith("pr list"));
    expect(listing).toBeDefined();
    expect(listing).not.toContain("labels");
    expect(edits(calls)).toEqual([]);
    expect(repo(r)?.labels).toBeUndefined();
  }, 60_000);
});

describe("jig install dispatch --repo", () => {
  const labelsFile = (w: World) => join(w.dir, "labels-repo.json");
  const created = (calls: string[]) =>
    calls.filter((c) => c.startsWith("label create "));
  const described = (calls: string[]) =>
    calls.filter((c) => c.startsWith("label edit "));
  /** A label of the set as the release describes it, with its color. */
  const current = (name: string) => {
    const spec = labelSet({ ...DEFAULT_LABELS, enabled: true }).find(
      (l) => l.name === name,
    );
    if (spec === undefined) throw new Error(`${name} is not in the set`);
    return spec;
  };
  /** The repository's labels as the fake forge keeps them, by name; a name alone has no description. */
  const repoLabels = (w: World) =>
    (
      JSON.parse(readFileSync(labelsFile(w), "utf8")) as Array<
        string | { name: string; description: string; color: string }
      >
    )
      .map((l) =>
        typeof l === "string"
          ? { name: l, description: "", color: "ededed" }
          : l,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  /** The labels part of the install, with or without --yes. */
  const labelsPart = (w: World, ...args: string[]) =>
    w.dispatch([w.repo, ...args], ENTRY);

  it("previews the timer and the labels the repository lacks", async () => {
    const w = fixture(ON);
    writeFileSync(labelsFile(w), JSON.stringify([current("jig:driving")]));
    const r = await w.dispatch(["install", "dispatch", "--repo", w.repo], JIG);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("--apply");
    expect(r.stdout).toContain("jig:converged");
    expect(r.stdout).not.toContain("jig:driving:");
    expect(created(ghCalls(w))).toEqual([]);
  }, 60_000);

  it("lists the missing labels, creates them with --yes, and lists for a person those the account may not create", async () => {
    const w = fixture(ON);
    writeFileSync(
      labelsFile(w),
      JSON.stringify([current("jig:driving"), "bug"]),
    );

    const preview = await labelsPart(w);
    expectSpawnExit(preview, 0);
    expect(preview.stdout).toContain("jig:converged");
    expect(preview.stdout).not.toContain("jig:driving:");
    expect(created(ghCalls(w, true))).toEqual([]);

    writeFileSync(join(w.dir, "label-create-fail"), "");
    const refused = await labelsPart(w, "--yes");
    expectSpawnExit(refused, 1);
    expect(refused.stdout).toContain(
      `gh label create 'jig:hold' --repo ${SLUG}`,
    );

    rmSync(join(w.dir, "label-create-fail"));
    ghCalls(w, true);
    const made = await labelsPart(w, "--yes");
    expectSpawnExit(made, 0);
    expect(created(ghCalls(w, true))).toHaveLength(11);
    expect(repoLabels(w).map((l) => l.name)).toEqual(
      [
        "automation",
        "bug",
        "jig:converged",
        "jig:drive",
        "jig:driving",
        "jig:followed-up",
        "jig:followup-failed",
        "jig:held",
        "jig:hold",
        "jig:parked",
        "jig:rearm",
        "jig:stale",
        "manual-ops",
      ].sort(),
    );

    const again = await labelsPart(w, "--yes");
    expectSpawnExit(again, 0);
    expect(created(ghCalls(w))).toEqual([]);
    expect(described(ghCalls(w))).toEqual([]);
  }, 60_000);

  it("lists a label whose description changed beside a missing one, updates it with --yes and keeps its color, and lists for a person one the account may not edit", async () => {
    const w = fixture(ON);
    const stale = current("jig:stale");
    // Installed by an earlier release, and recolored by a person since.
    const earlier = {
      ...stale,
      description: "An earlier release's meaning of the label",
      color: "000000",
    };
    const others = labelSet({ ...DEFAULT_LABELS, enabled: true }).filter(
      (l) => l.name !== stale.name,
    );
    writeFileSync(
      labelsFile(w),
      JSON.stringify([earlier, ...others, "manual-ops"]),
    );

    const preview = await labelsPart(w);
    expectSpawnExit(preview, 0);
    expect(preview.stdout).toContain(
      "these dispatch labels say what an earlier release meant by them; repeat with --yes to update them:",
    );
    expect(preview.stdout).toContain(`  jig:stale: ${stale.description}`);
    expect(preview.stdout).not.toContain("jig:driving:");
    // A label still missing is listed beside it.
    expect(preview.stdout).toContain(
      "these dispatch labels do not exist yet; repeat with --yes to create them:",
    );
    expect(preview.stdout).toContain("  automation: ");
    expect(described(ghCalls(w, true))).toEqual([]);

    writeFileSync(join(w.dir, "label-describe-fail"), "");
    const refused = await labelsPart(w, "--yes");
    expectSpawnExit(refused, 1);
    expect(refused.stdout).toContain(`${SLUG}: created automation`);
    expect(refused.stdout).toContain(
      `gh label edit 'jig:stale' --repo ${SLUG} --description '${stale.description}'`,
    );
    expect(repoLabels(w).find((l) => l.name === stale.name)).toEqual(earlier);

    rmSync(join(w.dir, "label-describe-fail"));
    ghCalls(w, true);
    const updated = await labelsPart(w, "--yes");
    expectSpawnExit(updated, 0);
    expect(updated.stdout).toContain(`${SLUG}: updated jig:stale`);
    expect(described(ghCalls(w, true))).toEqual([
      `label edit jig:stale --repo ${SLUG} --description ${stale.description}`,
    ]);
    expect(repoLabels(w).find((l) => l.name === stale.name)).toEqual({
      ...earlier,
      description: stale.description,
    });

    const again = await labelsPart(w, "--yes");
    expectSpawnExit(again, 0);
    expect(again.stdout).toContain(
      "every dispatch label under 'jig:' exists and says what this release means by it",
    );
    expect(described(ghCalls(w))).toEqual([]);
  }, 60_000);

  it("needs no label where the repository turns them off", async () => {
    const w = fixture(OFF);
    const r = await labelsPart(w, "--yes");
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("dispatch.labels is off");
    expect(ghCalls(w).filter((c) => c.startsWith("label "))).toEqual([]);
  }, 60_000);
});
