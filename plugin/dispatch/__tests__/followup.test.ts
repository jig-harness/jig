/**
 * dispatch --apply: follow-ups. A merged pull request gets one follow-up
 * marker and one headless pass running the repository's follow-up command,
 * once, bound to the admitted account through its configuration directory
 * and run with the host's permission settings, whatever the runtime says of
 * binding an interactive session. A pass that ends without recording done
 * is a failed follow-up, notified with the question it stopped on. A marker
 * is a claim: a manual run's holds the follow-up until it is marked done,
 * and a tick's whose record and outcome are gone is a failed follow-up.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import {
  manualMarker,
  MARKER,
  markerRun,
  tickMarker,
} from "../lib/followup-marker.ts";
import { readOutcomes } from "../lib/followup-outcomes.ts";
import { readRecord } from "../lib/launches.ts";
import { existingStateDb } from "../lib/state.ts";
import type { TickReceipt } from "../receipts.ts";
import { mergedPr, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  recordIds,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, orcaCalls } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  followup_command: /followup
`;

const HEAD = "feature/9-done";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** PR #9 merged, with its workspace; one account, `followup` enabled from before the merge. */
function fixture(): { w: World; ws: string } {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setPrs("merged", [mergedPr(9, HEAD, "2026-10-31T12:00:00Z")]);
  w.setComments(9, []);
  const ws = join(w.root, "ws-9");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 9, path: ws }]);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["followup"], {
    followup_since: "2026-10-30T00:00:00Z",
  });
  return { w, ws };
}

/** A report-only tick, from the machine file's repository and follow-up window. */
async function report(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

type Comment = { id: number; body: string; user: { login: string } };

function comments(w: World): Comment[] {
  return JSON.parse(readFileSync(join(w.dir, "comments-9.json"), "utf8"));
}

const markers = (w: World) =>
  comments(w).filter((c) => c.body.startsWith(MARKER));

/** Who posts the markers this suite seeds: on PR #9, from one host. */
const POST = { pr: 9, writer: { host: "sha256:0123456789abcdef" } };

/** What each marker on PR #9 says. */
const runs = (w: World) => markers(w).map((m) => markerRun(m.body, 9));

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];
const quiet = (r: TickReceipt) => r.repos[0]?.quiet ?? [];

/** The one follow-up a tick launched, its launch record and the marker it posted. */
async function launchedFollowup(w: World) {
  // Orca's real answer: it binds no interactive session, which a headless pass does not need.
  const first = await applyTick(w, false);
  expect(launches(first)).toEqual([
    expect.objectContaining({
      action: "followup",
      target: "PR #9",
      outcome: "launched",
      account: "a",
      detail: expect.stringContaining(
        "a headless follow-up pass bound to account a",
      ),
    }),
  ]);
  const id = String(launches(first)[0]?.record);
  const record = readRecord(id, dispatchState(w));
  if (record === null) throw new Error(`no launch record ${id}`);
  const [marker] = markers(w);
  if (marker === undefined) throw new Error("no follow-up marker");
  return { id, record, marker };
}

describe("jig dispatch --apply follows up a merge", () => {
  it("starts a headless follow-up pass bound to the admitted account, and the report and launch record say so", async () => {
    const { w, ws } = fixture();
    const { id, record, marker } = await launchedFollowup(w);
    expect(record).toMatchObject({
      action: "followup",
      pr: 9,
      workspace: { path: ws },
      configDir: join(w.root, "config-a"),
      codexBypass: false,
      marker: marker.id,
    });
    expect(typeof record.passTimeoutSec).toBe("number");
    // The marker names this host, as its dispatcher database's digest, and that it owns the repository.
    expect(runs(w)).toEqual([
      {
        kind: "tick",
        record: id,
        host: expect.stringMatching(/^sha256:[0-9a-f]{16}$/),
        owner: true,
      },
    ]);
    expect(marker.body.split("\n").at(-1)).toBe(
      `jig dispatch follow-up · record: ${id}`,
    );

    await waitFor("the pass", () => claudeRuns(w).length === 1);
    const [run] = claudeRuns(w);
    expect(run).toMatchObject({ configDir: join(w.root, "config-a"), cwd: ws });
    const argv = run?.argv ?? [];
    expect(argv.at(-2)).toBe("-p");
    expect(argv).not.toContain("--permission-mode");
    const prompt = argv.at(-1) ?? "";
    expect(prompt.startsWith("/followup 9\n")).toBe(true);
    expect(prompt).toContain("headless");
    expect(prompt).toContain(`marker check 9 --comment ${marker.id}`);
    expect(prompt).toContain(`dispatch result ${id} ${record.token} done`);
  });

  it("holds the follow-up while its pass runs, and settles it done for good once the pass records done", async () => {
    const { w } = fixture();
    const { id, record } = await launchedFollowup(w);
    await waitFor("the pass", () => claudeRuns(w).length === 1);

    // The pass runs: its wrapper holds the follow-up and its slot.
    const second = await applyTick(w, false);
    expect(launches(second)).toEqual([]);
    expect(second.repos[0]?.running.map((r) => r.target)).toEqual(["PR #9"]);
    expect(markers(w)).toHaveLength(1);
    expect(orcaCalls(w, "terminal", "create")).toHaveLength(1);
    expect(recordIds(w)).toEqual([id]);

    // The pass records done and ends.
    expectSpawnExit(await w.dispatch(["result", id, record.token, "done"]), 0);
    writeFileSync(join(w.dir, "claude-exit"), "");
    await waitFor("the exit", () => exitWritten(w, id));
    const third = await applyTick(w, false);
    expect(launches(third)).toEqual([]);
    expect(quiet(third)).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-done" }),
    );
    expect(readOutcomes(SLUG, dispatchState(w)).get(9)).toMatchObject({
      record: id,
      outcome: "done",
    });
    expect(claudeRuns(w)).toHaveLength(1);
  });

  it("notifies a pass that stopped on a question, with the question, and never starts it again", async () => {
    const { w } = fixture();
    const [launched] = launches(await applyTick(w, false));
    const id = String(launched?.record);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    writeFileSync(
      join(w.dir, "claude-said"),
      "I cannot tag the release.\nQuestion: which version does this merge ship in?\n",
    );
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the exit", () => exitWritten(w, id));

    const after = await applyTick(w, false);
    expect(launches(after)).toEqual([]);
    const [action] = after.repos[0]?.actions ?? [];
    expect(action).toMatchObject({
      stage: "notify",
      target: "PR #9",
      cause: "followup-failed",
    });
    const question = "which version does this merge ship in?";
    expect(action?.reason).toContain(question);
    expect(action?.evidence.question).toBe(question);
    expect(action?.notice?.text).toContain(question);
    expect(claudeRuns(w)).toHaveLength(1);
  });

  it("stops a pass at its deadline with the tool commands it started, and settles the slot only after", async () => {
    const { w } = fixture();
    w.env.DRIVE_PR_PASS_TIMEOUT = "1";
    writeFileSync(join(w.dir, "claude-stubborn"), "");
    const [launched] = launches(await applyTick(w, false));
    const id = String(launched?.record);
    expect(readRecord(id, dispatchState(w))?.passTimeoutSec).toBe(1);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    await waitFor("the tool command", () =>
      existsSync(join(w.dir, "claude-tool-pid")),
    );
    const tool = Number(readFileSync(join(w.dir, "claude-tool-pid"), "utf8"));
    await waitFor("the exit", () => exitWritten(w, id), 40_000);
    const alive = () => {
      try {
        process.kill(tool, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(false);
    const row = existingStateDb(dispatchState(w))
      ?.query("SELECT exit FROM launches WHERE id = ?")
      .get(id) as { exit: string };
    expect(JSON.parse(row.exit)).toMatchObject({ signal: "SIGKILL" });
  }, 60_000);

  it("keeps the question of a pass whose last line is longer than the output's kept end", async () => {
    const { w } = fixture();
    const [launched] = launches(await applyTick(w, false));
    const id = String(launched?.record);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    writeFileSync(
      join(w.dir, "claude-said"),
      `Question: ${"which version? ".repeat(120)}\n${"noise ".repeat(500)}\n`,
    );
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the exit", () => exitWritten(w, id));
    const after = await applyTick(w, false);
    const [action] = after.repos[0]?.actions ?? [];
    expect(action?.evidence.question).toContain("which version?");
  });

  it("keeps a question whose multi-byte character arrives split across two writes", async () => {
    const { w } = fixture();
    const [launched] = launches(await applyTick(w, false));
    const id = String(launched?.record);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    writeFileSync(join(w.dir, "claude-split"), "");
    writeFileSync(join(w.dir, "claude-said"), "Question: publish café?\n");
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the exit", () => exitWritten(w, id));
    const after = await applyTick(w, false);
    const [action] = after.repos[0]?.actions ?? [];
    expect(action?.evidence.question).toBe("publish café?");
  });

  it("runs the pass with the permission settings of the host's user layer", async () => {
    const { w } = fixture();
    // Only the home directory places the user layer, and no other layer speaks.
    delete w.env.JIG_HOME;
    delete w.env.JIG_USER_LAYER;
    delete w.env.JIG_OVERLAY;
    writeFileSync(
      join(w.home, ".jig", "jig.yaml"),
      "drive:\n  pass_args: [--permission-mode, bypassPermissions]\n",
    );
    await applyTick(w, false);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    const argv = claudeRuns(w)[0]?.argv ?? [];
    const at = argv.indexOf("--permission-mode");
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe("bypassPermissions");
    expect(at).toBeLessThan(argv.indexOf("-p"));
  });

  it("holds a follow-up a person's run claimed until that run marks it done", async () => {
    const { w } = fixture();
    w.setComments(9, [forgeComment(901, manualMarker(false, POST))]);
    const held = await report(w);
    expect(held.repos[0]?.actions).toEqual([]);
    expect(quiet(held)).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-held" }),
    );

    const done = await w.dispatch([
      "marker",
      "done",
      "9",
      "--comment",
      "901",
      "--repo",
      SLUG,
    ]);
    expectSpawnExit(done, 0);
    expect(runs(w)).toEqual([{ kind: "manual", done: true }]);
    expect(quiet(await report(w))).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-done" }),
    );
  });

  it("holds a follow-up claimed by a marker in the line form written before the envelope", async () => {
    const { w } = fixture();
    w.setComments(9, [
      forgeComment(
        906,
        `${MARKER}\njig dispatch follow-up · run: manual · outcome: running`,
      ),
    ]);
    const held = await report(w);
    expect(held.repos[0]?.actions).toEqual([]);
    expect(quiet(held)).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-held" }),
    );
  });

  it("reads a marker whose comment was saved with CRLF line endings", async () => {
    const { w } = fixture();
    w.setComments(9, [
      forgeComment(905, manualMarker(false, POST).replace(/\n/g, "\r\n")),
    ]);
    const held = await report(w);
    expect(held.repos[0]?.actions).toEqual([]);
    expect(quiet(held)).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-held" }),
    );
  });

  it("notifies a failed follow-up when the tick's marker names a record this machine no longer has", async () => {
    const { w } = fixture();
    w.setComments(9, [
      forgeComment(
        902,
        tickMarker("20261030T200000Z-aaaaaaaa", POST),
        "drive-bot",
      ),
    ]);
    const r = await report(w);
    expect(r.repos[0]?.actions).toEqual([
      expect.objectContaining({
        stage: "notify",
        target: "PR #9",
        cause: "followup-failed",
      }),
    ]);
  });

  it("ignores a marker from someone who cannot write, and names it", async () => {
    const { w } = fixture();
    w.setComments(9, [
      forgeComment(903, manualMarker(true, POST), "passer-by", "NONE"),
    ]);
    const [action] = (await report(w)).repos[0]?.actions ?? [];
    expect(action?.stage).toBe("followup");
    expect(String(action?.evidence.ignoredMarkers)).toContain(
      "903 by passer-by",
    );
  });

  it("stands a manual claim down behind an earlier marker, deleting its own", async () => {
    const { w } = fixture();
    w.setComments(9, [forgeComment(904, manualMarker(false, POST))]);
    const r = await w.dispatch(["marker", "claim", "9", "--repo", SLUG]);
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain("comment 904");
    expect(markers(w).map((m) => m.id)).toEqual([904]);
  });

  it("leaves one claim when a manual run and a tick race on a pull request: the tick stands down before it starts anything", async () => {
    const { w } = fixture();
    // The manual run's marker lands while the tick's post is in flight, with the lower id.
    writeFileSync(
      join(w.dir, "race-on-claim"),
      JSON.stringify(forgeComment(50, manualMarker(false, POST))),
    );
    const r = await applyTick(w, true);
    expect(launches(r)).toEqual([
      expect.objectContaining({ target: "PR #9", outcome: "refused" }),
    ]);
    expect(JSON.stringify(launches(r))).toContain("comment 50");
    expect(markers(w).map((m) => m.id)).toEqual([50]);
    expect(recordIds(w)).toEqual([]);
    expect(claudeRuns(w)).toEqual([]);
    const check = ["marker", "check", "9", "--comment", "50", "--repo", SLUG];
    expectSpawnExit(await w.dispatch(check), 0);
  });

  it("leaves one claim when a manual run's post races the tick's marker: the manual run stops before it acts", async () => {
    const { w } = fixture();
    writeFileSync(
      join(w.dir, "race-on-claim"),
      JSON.stringify(
        forgeComment(
          50,
          tickMarker("20261030T200000Z-aaaaaaaa", POST),
          "drive-bot",
        ),
      ),
    );
    const r = await w.dispatch(["marker", "claim", "9", "--repo", SLUG]);
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain("comment 50");
    expect(markers(w).map((m) => m.id)).toEqual([50]);
  });

  it("claims a follow-up with a manual marker and checks the claim before each act", async () => {
    const { w } = fixture();
    const claimed = await w.dispatch(["marker", "claim", "9", "--repo", SLUG]);
    expectSpawnExit(claimed, 0);
    const { comment } = JSON.parse(claimed.stdout) as { comment: number };
    expect(runs(w)).toEqual([{ kind: "manual", done: false }]);
    const check = [
      "marker",
      "check",
      "9",
      "--comment",
      String(comment),
      "--repo",
      SLUG,
    ];
    expectSpawnExit(await w.dispatch(check), 0);
    // A marker that a lagging read hid, earlier than this one, stops the run.
    w.setComments(9, [
      forgeComment(50, manualMarker(false, POST)),
      ...comments(w),
    ]);
    expectSpawnExit(await w.dispatch(check), 3);
  });
});
