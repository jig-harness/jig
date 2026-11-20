import { afterEach, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLine } from "../lib/line-store.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { assignedIssue, SLUG, type World, world } from "./fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function fixture(answer: string): World {
  const w = world();
  current = w;
  w.setConfig(`issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`);
  w.setIssues([assignedIssue(12, "factory-bot", [])]);
  w.setAssigner(12, "maintainer", "WRITE");
  withOrigin(w);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["pickup"]);
  writeFileSync(join(w.dir, "claude-sign-in"), answer);
  writeFileSync(join(w.dir, "claude-exit"), "0");
  return w;
}

it("holds a rejected Claude account and shows one sign-in need", async () => {
  const w = fixture("unauthorized");
  const tick = await applyTick(w, false);
  expect(tick.repos[0]?.launches[0]).toMatchObject({
    outcome: "refused",
    detail: expect.stringContaining("rejected the account sign-in"),
  });
  expect(claudeRuns(w)).toHaveLength(0);
  const line = readLine(dispatchState(w));
  expect(
    line.ok &&
      line.value?.needs.filter((need) => need.cause === "account-sign-in"),
  ).toHaveLength(1);
});

it("keeps identity admission when the sign-in check times out", async () => {
  const w = fixture("timeout");
  const tick = await applyTick(w, false);
  const launch = tick.repos[0]?.launches[0];
  expect(launch?.outcome).toBe("launched");
  expect(tick.signInFallbacks).toEqual([
    { account: "a", failure: "unreachable" },
  ]);
  const line = readLine(dispatchState(w));
  expect(
    line.ok &&
      line.value?.needs.filter((need) => need.cause === "account-sign-in"),
  ).toHaveLength(0);
  await waitFor("the launch to exit", () =>
    exitWritten(w, String(launch?.record)),
  );
}, 20_000);
