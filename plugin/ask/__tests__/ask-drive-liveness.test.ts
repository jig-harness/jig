/** A running forge ledger is a claim, rather than a local process probe. */
import { afterEach, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { stoppedLedger } from "../../dispatch/__tests__/fixtures.ts";
import { ledgerBody } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import type { AskAnswer } from "../lib/answer.ts";
import {
  askWorld,
  comment,
  pullDoc,
  REPO,
  type AskWorld,
} from "./ask-fixtures.ts";

let w: AskWorld | null = null;
afterEach(() => {
  w?.close();
  w = null;
});

function world(row: unknown = null): AskWorld {
  w = askWorld();
  w.api("user", { login: "drive-bot" });
  w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
  w.api(`repos/${REPO}/issues/7/comments`, [
    comment(
      701,
      ledgerBody(
        stoppedLedger(7, undefined, {
          driver: {
            actor: "wt-0123456789abcdef",
            clone: "clone-a",
            heartbeat: new Date().toISOString(),
            state: "running",
            started: "2026-11-06T22:00:00Z",
          },
        }),
      ),
    ),
  ]);
  const script = join(w.root, "drives.ts");
  writeFileSync(
    script,
    `console.log(${JSON.stringify(JSON.stringify({ rows: row === null ? [] : [row] }))});`,
  );
  w.env.JIG_ASK_DRIVES_SCRIPT = script;
  return w;
}

it("names unknown liveness without inferring a foreign clone from a running ledger", async () => {
  const w = world();
  const r = await w.ask([`drive@${REPO}#7`, "--json"]);
  expectSpawnExit(r, 0);
  const a = JSON.parse(r.stdout) as AskAnswer;
  expect(a.holder).toMatchObject({ process: "unknown", host: "unknown" });
  expect(JSON.stringify(a.holder)).not.toContain("not on this machine");
  expect(a.waitsOn).toMatchObject({
    waiting: expect.stringContaining("liveness"),
  });
  expect(a.stateDetail).toContain("liveness");
  expect(w.writes()).toEqual([]);
});

function heldRow(extra: Record<string, unknown> = {}) {
  return {
    kind: "pr",
    key: "7",
    state: "empty",
    host: null,
    doctor: {
      verdict: "UNKNOWN",
      reason: "local driver stopped",
      recovery: null,
      ciHold: {
        driver: "dead",
        driverReason: "the identified local driver stopped",
        head: "a".repeat(40),
        label: "ci:hold",
        held: true,
        review: "converged",
        reason: "ci:hold blocks final CI",
        recovery: `bun ci-hold.ts release 7 --expect-head ${"a".repeat(40)}`,
        worktree: "/checkout",
        actor: "wt-0123456789abcdef",
        started: "2026-11-06T22:00:00Z",
        generation: 1,
        ledgerGeneration: 3,
        ...extra,
      },
    },
  };
}

it("reconciles a stopped local driver with its recent running ledger and offers the direct guarded release", async () => {
  const w = world(heldRow());
  const r = await w.ask([`drive@${REPO}#7`, "--json"]);
  expectSpawnExit(r, 0);
  const a = JSON.parse(r.stdout) as AskAnswer;
  expect(a.state).toBe("stopped");
  expect(a.holder).toBe("none");
  expect(a.stateDetail).toContain("ledger reports running");
  expect(a.waitsOn).toMatchObject({
    person: "release the CI hold",
    why: expect.stringContaining("starts full CI"),
  });
  expect(w.writes()).toEqual([]);
});

for (const extra of [
  { driver: "alive", recovery: null },
  { driver: "unknown", recovery: null },
  { head: "b".repeat(40) },
  { review: "unknown", recovery: null },
  { review: "pending", recovery: null },
  { ledgerGeneration: 4 },
  { actor: null },
  { started: null },
  { ledgerGeneration: null },
  { actor: "wt-ffffffffffffffff" },
  { started: "2026-11-06T23:00:00Z" },
])
  it(`withholds direct release for incomplete or superseded evidence ${JSON.stringify(extra)}`, async () => {
    const w = world(heldRow(extra));
    const r = await w.ask([`drive@${REPO}#7`, "--json"]);
    expectSpawnExit(r, 0);
    const a = JSON.parse(r.stdout) as AskAnswer;
    expect(a.waitsOn).not.toHaveProperty("person", "release the CI hold");
    expect(a.waitsOn).toHaveProperty("waiting");
    expect(w.writes()).toEqual([]);
  });

it("keeps a pending human decision visible even when the local hold diagnosis offers release", async () => {
  const w = world(heldRow());
  w.api(`repos/${REPO}/issues/7/comments`, [
    comment(
      701,
      ledgerBody(
        stoppedLedger(7, 8, {
          parked: [
            {
              key: "PRRT_question",
              kind: "thread",
              reason: "Keep the old flag?",
              round: 2,
              at: "2026-11-06T22:00:00Z",
            },
          ],
        }),
      ),
    ),
  ]);
  const r = await w.ask([`drive@${REPO}#7`, "--json"]);
  expectSpawnExit(r, 0);
  const a = JSON.parse(r.stdout) as AskAnswer;
  expect(a.waitsOn).toMatchObject({ person: "answer", act: "Decide" });
  expect(w.writes()).toEqual([]);
});

it("withholds release and names missing ledger ownership when the comments cannot be read", async () => {
  const w = world(heldRow());
  w.api(`repos/${REPO}/issues/7/comments`, {});
  const r = await w.ask([`drive@${REPO}#7`, "--json"]);
  expectSpawnExit(r, 0);
  const a = JSON.parse(r.stdout) as AskAnswer;
  expect(a.waitsOn).toMatchObject({
    waiting: expect.stringContaining("ownership remains unknown"),
  });
  expect(w.writes()).toEqual([]);
});

it("names a park under release Authorize, as the dashboard's card does", async () => {
  const w = world(heldRow());
  w.api(`repos/${REPO}/issues/7/comments`, [
    comment(
      701,
      ledgerBody(
        stoppedLedger(7, 8, {
          parked: [
            {
              key: "PRRT_release",
              kind: "thread",
              reason: "Tag v0.159.0 from a bypass account?",
              class: "release",
              round: 2,
              at: "2026-11-06T22:00:00Z",
            },
          ],
        }),
      ),
    ),
  ]);
  const r = await w.ask([`drive@${REPO}#7`, "--json"]);
  expectSpawnExit(r, 0);
  const a = JSON.parse(r.stdout) as AskAnswer;
  expect(a.waitsOn).toMatchObject({ person: "answer", act: "Authorize" });
  const text = await w.ask([`drive@${REPO}#7`]);
  expect(text.stdout).toContain("person: answer · Authorize");
});
