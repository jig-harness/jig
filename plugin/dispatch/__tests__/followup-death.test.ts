/**
 * dispatch --apply: a follow-up whose session died during its work, with no
 * result recorded and no question stated, is run again once: the tick
 * releases the marker the dead pass left, even one already answered failed,
 * and a later tick starts the follow-up again. A second death of the same
 * follow-up is a person's.
 */
import { afterEach, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimBody } from "../../shared/records/forge-claims.ts";
import {
  FOLLOWUP_CLAIM,
  tickClaim,
} from "../../shared/records/launch-claims.ts";
import { MARKER } from "../lib/followup-marker.ts";
import { readRecord } from "../lib/launches.ts";
import type { TickReceipt } from "../receipts.ts";
import { mergedPr, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  followup_command: /followup\n`,
  );
  withOrigin(w);
  w.setPrs("merged", [mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z")]);
  w.setComments(9, []);
  const ws = join(w.root, "ws-9");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: "feature/9-done", linkedPR: 9, path: ws }]);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    {},
    ["followup", "notify"],
    {
      followup_since: "2026-10-30T00:00:00Z",
    },
  );
  return w;
}

type Comment = { id: number; body: string };

const commentsPath = (w: World) => join(w.dir, "comments-9.json");
const comments = (w: World): Comment[] =>
  JSON.parse(readFileSync(commentsPath(w), "utf8"));
const markers = (w: World) =>
  comments(w).filter((c) => c.body.startsWith(MARKER));

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];

/** Launch the follow-up and let its pass die `code` after it started work (its transcript written); its launch record. */
async function dies(w: World, code: number): Promise<string> {
  const runs = claudeRuns(w).length;
  const [launched] = launches(await applyTick(w, false));
  expect(launched).toMatchObject({ action: "followup", outcome: "launched" });
  const id = String(launched?.record);
  await waitFor("the pass", () => claudeRuns(w).length === runs + 1);
  const record = readRecord(id, dispatchState(w));
  const projects = join(String(record?.configDir), "projects", "work");
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${String(record?.sessionId)}.jsonl`), "{}\n");
  writeFileSync(join(w.dir, "claude-exit"), String(code));
  await waitFor("the exit", () => exitWritten(w, id));
  rmSync(join(w.dir, "claude-exit"));
  return id;
}

it("runs a follow-up that died again once, past its stale failed marker, and hands a second death to a person", async () => {
  const w = fixture();
  const first = await dies(w, 143);

  // The marker the dead pass left already carries a failed answer.
  const [marker] = markers(w);
  if (marker === undefined) throw new Error("no follow-up marker");
  w.setComments(
    9,
    comments(w).map((c) =>
      c.id === marker.id ? { ...c, body: failedBody(first) } : c,
    ),
  );

  const release = await applyTick(w, false);
  expect(launches(release)).toEqual([]);
  expect(release.repos[0]?.running).toContainEqual(
    expect.objectContaining({
      target: "PR #9",
      stage: "followup",
      reason: expect.stringContaining(
        `launch record ${first}'s pass died with no result and no question`,
      ),
    }),
  );
  expect(markers(w)).toEqual([]);

  const second = await dies(w, 255);
  const rerun = readRecord(second, dispatchState(w));
  expect(rerun?.facts.startsWith("recovery: ")).toBe(true);
  expect(claudeRuns(w)).toHaveLength(2);

  const after = await applyTick(w, false);
  expect(launches(after)).toEqual([]);
  expect(after.repos[0]?.actions).toContainEqual(
    expect.objectContaining({
      stage: "notify",
      target: "PR #9",
      cause: "followup-failed",
      reason: expect.stringContaining(
        "dying again after the tick ran it again once",
      ),
    }),
  );
  expect(after.repos[0]?.notifications).toContainEqual(
    expect.objectContaining({ cause: "followup-failed", outcome: "sent" }),
  );
  expect(claudeRuns(w)).toHaveLength(2);
}, 180_000);

/** The marker body of a tick's follow-up under `record`, answered failed. */
function failedBody(record: string): string {
  return claimBody(
    FOLLOWUP_CLAIM,
    tickClaim(
      record,
      { pr: 9, writer: { host: "sha256:0123456789abcdef" } },
      "failed",
    ),
  );
}
