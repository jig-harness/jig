/**
 * dispatch --apply, end to end: a follow-up's pass that ends with no closing
 * report has its transcript copied by its wrapper, and its outcome row says
 * `by: none` with the copy's path; on a host whose steward is on, the run is
 * listed in the steward's digest with its excerpt, and the cause a steward
 * submits for it is written onto the row, `by: steward`, by the next tick.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readRecord, recordExit } from "../lib/launches.ts";
import { type EndedRow, readRows } from "../lib/log.ts";
import { readStewardDigest, submitStewardRecords } from "../lib/steward.ts";
import { runDir } from "../lib/transcript-copy.ts";
import type { TickReceipt } from "../receipts.ts";
import { mergedPr, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  earlierRecord,
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

const SESSION = "0b6f2a1e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const LINE = {
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "Closed #41; the release tag push failed." },
    ],
  },
};

/** Write a Claude Code transcript of `session` under the account's configuration directory. */
function transcript(configDir: string, session: string): void {
  const dir = join(configDir, "projects", "work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session}.jsonl`), `${JSON.stringify(LINE)}\n`);
}

function endedRow(w: World, id: string): EndedRow | undefined {
  return readRows(undefined, undefined, dispatchState(w)).find(
    (r): r is EndedRow => r.kind === "ended" && r.record === id,
  );
}

describe("a follow-up's pass that left no report", () => {
  it("has its transcript copied by its wrapper, and its row names the copy", async () => {
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
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["followup"], {
      followup_since: "2026-10-30T00:00:00Z",
    });
    const receipt = await applyTick(w, false);
    const launched = receipt.repos[0]?.launches.find(
      (l) => l.action === "followup",
    );
    expect(launched).toMatchObject({ outcome: "launched" });
    const id = String(launched?.record);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    const record = readRecord(id, dispatchState(w));
    transcript(String(record?.configDir), String(record?.sessionId));
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the exit", () => exitWritten(w, id));
    const copied = join(runDir(dispatchState(w), id), "transcript.jsonl");
    expect(existsSync(copied)).toBe(true);
    expectSpawnExit(await w.dispatch(["--apply", "--json"]), 0);
    expect(endedRow(w, id)).toMatchObject({ by: "none", transcript: copied });
  });
});

const RUN = "20261114T101301Z-33c6fa5f";

/** A host whose steward is on, with a follow-up's run that ended without a report and whose transcript is on the host. */
function stewardWorld(): World {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  followup_command: /followup\n`,
  );
  withOrigin(w);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    { steward: { enabled: true } },
    ["steward"],
  );
  const record = earlierRecord(w, {
    id: RUN,
    account: "a",
    action: "followup",
    pr: 9,
    headless: true,
    command: "/followup",
    sessionId: SESSION,
    createdAt: new Date(Date.now() - 600_000).toISOString(),
  });
  transcript(record.configDir, SESSION);
  recordExit(
    RUN,
    { at: new Date().toISOString(), code: 1, signal: null },
    dispatchState(w),
  );
  writeFileSync(join(w.dir, "orca-terminal-noop"), "");
  return w;
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

describe("the steward's cause for a run without a report", () => {
  it("lists the run with its excerpt in the digest, and the next tick records the cause by steward", async () => {
    const w = stewardWorld();
    let steward: string | null | undefined;
    for (let i = 0; i < 2 && typeof steward !== "string"; i++)
      steward = (await tick(w)).repos[0]?.launches.find(
        (l) => l.action === "steward",
      )?.record;
    expect(typeof steward).toBe("string");
    expect(endedRow(w, RUN)).toMatchObject({ by: "none" });
    expect(endedRow(w, RUN)?.transcript).toBe(
      join(runDir(dispatchState(w), RUN), "transcript.jsonl"),
    );
    const digest = readStewardDigest(String(steward), dispatchState(w));
    if (!digest.ok) throw new TypeError(digest.failure.reason);
    expect(digest.value.backlog).toContainEqual({
      kind: "cause",
      target: RUN,
      facts: "",
    });
    expect(digest.value.unreported).toEqual([
      expect.objectContaining({
        record: RUN,
        target: "PR #9",
        excerpt: expect.objectContaining({
          untrusted: true,
          assistant: ["Closed #41; the release tag push failed."],
        }),
      }),
    ]);
    expect(
      submitStewardRecords(
        String(steward),
        [
          {
            kind: "cause",
            record: RUN,
            cause: "tool-failed",
            summary: "It closed #41; the release tag push then failed.",
            reason: "the excerpt ends on the failed push",
          },
        ],
        dispatchState(w),
      ).ok,
    ).toBe(true);
    await tick(w);
    expect(endedRow(w, RUN)).toMatchObject({
      by: "steward",
      cause: "tool-failed",
      concluded: "It closed #41; the release tag push then failed.",
    });
    expect(readRecord(RUN, dispatchState(w))).not.toBeNull();
  });
});
