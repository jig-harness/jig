/**
 * The one nudge through real ticks, with Orca faked to bind interactive
 * sessions (`pickup-fixtures.ts`): a pickup session launched with its
 * vendor session id, which the runtime reports waiting after its account's
 * wall reset, gets exactly one continue nudge across three ticks; a session
 * still waiting after it is notified, never nudged again.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecordFile } from "../lib/launches.ts";
import { readRows } from "../lib/log.ts";
import { NUDGES } from "../lib/runtime/port.ts";
import { assignedIssue, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`;

/** The quota probe in tests: it prints `quota-wall.json`, else no wall, and records how it was run. */
const FAKE_PROBE = `const fs = require("node:fs");
const F = process.env.DISPATCH_FAKE_DIR;
fs.appendFileSync(F + "/probe-runs.jsonl", JSON.stringify({ argv: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR ?? null }) + "\\n");
const wall = F + "/quota-wall.json";
process.stdout.write(fs.existsSync(wall) ? fs.readFileSync(wall, "utf8") : "null");
`;

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

function lines<T>(path: string): T[] {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as T)
    : [];
}

/** Mark the agent `paneKey` in the workspace at `path` as `state` in the fake runtime's listing. */
function agentIn(w: World, path: string, paneKey: string, state: string): void {
  const file = join(w.dir, "orca-ps.json");
  const ps = JSON.parse(readFileSync(file, "utf8")) as {
    worktrees: Array<Record<string, unknown>>;
  };
  const row = ps.worktrees.find((r) => r.path === path);
  if (row === undefined) throw new Error(`no workspace ${path}`);
  row.agents = [
    { paneKey, state, agentType: "claude", stateStartedAt: Date.now() },
  ];
  writeFileSync(file, JSON.stringify(ps));
}

describe("the continue nudge", () => {
  it("nudges a session waiting after its account's wall reopened exactly once across three ticks", async () => {
    const w = world();
    current = w;
    w.setConfig(CONFIG);
    w.setIssues([assignedIssue(12, "factory-bot", [])]);
    w.setAssigner(12, "maintainer", "WRITE");
    withOrigin(w);
    const a = account(w, "a", "a@example.com");
    machineFile(w, [a], {}, ["pickup", "steer", "notify"]);
    writeFileSync(join(w.root, "fake-probe.js"), FAKE_PROBE);
    w.env.JIG_DISPATCH_QUOTA_PROBE = join(w.root, "fake-probe.js");

    // The pickup starts, with the session id the tick minted.
    const first = await applyTick(w, true);
    const id = String(first.repos[0]?.launches[0]?.record);
    const record = readRecordFile(id, dispatchState(w));
    const session = record?.sessionId ?? "";
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor("the session", () => claudeRuns(w).length === 1);
    const argv = claudeRuns(w)[0]?.argv ?? [];
    expect(
      argv.slice(
        argv.indexOf("--session-id"),
        argv.indexOf("--session-id") + 2,
      ),
    ).toEqual(["--session-id", session]);

    // Its agent waits at an empty prompt; its record says the wall it met has reset.
    const workspace = record?.workspace?.path ?? "";
    agentIn(w, workspace, "tab-1:leaf-1", "waiting");
    writeFileSync(
      join(w.dir, "orca-terminals.json"),
      JSON.stringify([
        {
          handle: "term-1",
          tabId: "tab-1",
          leafId: "leaf-1",
          worktreePath: workspace,
          writable: true,
        },
      ]),
    );
    writeFileSync(
      join(w.dir, "orca-screen.json"),
      JSON.stringify([
        "  ⎿  You've hit your session limit · resets 3am (UTC)",
        "",
        "────────────────────────────",
        "> ",
        "────────────────────────────",
        "  ? for shortcuts",
      ]),
    );
    const observedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    writeFileSync(
      join(w.dir, "quota-wall.json"),
      JSON.stringify({
        observedAt,
        resetAt: new Date(Date.now() - 60_000).toISOString(),
        window: "short",
        evidence: "You've hit your session limit · resets 3am (UTC)",
        last: true,
      }),
    );

    const ticks = [
      await applyTick(w, true),
      await applyTick(w, true),
      await applyTick(w, true),
    ];

    const sends = lines<{ terminal: string; text: string; enter: boolean }>(
      join(w.dir, "orca-sends.jsonl"),
    );
    expect(sends).toEqual([
      { terminal: "term-1", text: NUDGES.continue, enter: true },
    ]);
    expect(
      ticks.map((t) => (t.repos[0]?.steers ?? []).map((s) => s.outcome)),
    ).toEqual([["sent"], [], []]);
    // Still waiting on the same wall after its nudge: a person hears of it, once.
    const unanswered = ticks.map((t) =>
      (t.repos[0]?.notifications ?? [])
        .filter((n) => n.cause === "nudge-unanswered")
        .map((n) => n.outcome),
    );
    expect(unanswered).toEqual([[], ["sent"], ["suppressed"]]);
    // The probe read the session's own record, in its account's directory.
    const probe = lines<{ argv: string[]; configDir: string | null }>(
      join(w.dir, "probe-runs.jsonl"),
    )[0];
    expect(probe?.argv.slice(0, 3)).toEqual(["quota", session, workspace]);
    expect(probe?.configDir).toBe(a.dir);
    expect(
      readRecordFile(id, dispatchState(w))?.episodes?.map((e) => e.observedAt),
    ).toEqual([observedAt]);
    const nudges = readRows(undefined, undefined, dispatchState(w)).filter(
      (r) => r.kind === "event" && r.event === "nudge",
    );
    expect(nudges.map((r) => [r.target, r.reason.split(":")[0]])).toEqual([
      ["#12", "continue delivered"],
    ]);
  }, 120_000);
});
