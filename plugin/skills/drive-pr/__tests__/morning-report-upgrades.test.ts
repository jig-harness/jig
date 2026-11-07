/**
 * `drives.ts --report`: the plugin upgrades the timers ran on this machine
 * since the report's time, from collection's and the dispatcher's receipts.
 * An upgrade that moved the plugin and one that failed are listed, each
 * once; one withheld, skipped or unchanged, or one from before the report's
 * time, is not.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  newRunId,
  writeReceipt as writeTick,
} from "../../../dispatch/receipts.ts";
import { closeStateDb } from "../../../dispatch/lib/state.ts";
import { writeReceipt as writeGc } from "../../../gc/receipts.ts";
import type { ScheduledUpgrade } from "../../../runtime/upgrade-record.ts";
import {
  fakeForge,
  type Forge,
  runIn,
  SCRIPTS,
} from "./provisional-fixtures.ts";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) closeStateDb(root);
  roots = [];
});

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

/** A collection run's receipt that carries `upgrade`. */
function gcReceipt(forge: Forge, upgrade: ScheduledUpgrade): void {
  const startedAt = upgrade.at;
  writeGc(
    {
      version: 1,
      runId: `${startedAt.replace(/:/g, "-")}-1-${crypto.randomUUID()}`,
      startedAt,
      finishedAt: startedAt,
      collect: false,
      completed: true,
      kinds: [],
      resources: [],
      exitStatus: 0,
      upgrade,
    },
    join(forge.env.HOME as string, ".local", "state", "jig", "gc"),
  );
}

/** A dispatcher tick's receipt that carries `upgrade`. */
function tickReceipt(forge: Forge, upgrade: ScheduledUpgrade): void {
  const root = join(
    forge.env.HOME as string,
    ".local",
    "state",
    "jig",
    "dispatch",
  );
  roots.push(root);
  writeTick(
    {
      version: 1,
      runId: newRunId(new Date(upgrade.at)),
      startedAt: upgrade.at,
      finishedAt: upgrade.at,
      completed: true,
      apply: true,
      exitStatus: 0,
      repos: [],
      upgrade,
    },
    root,
  );
}

describe("drives.ts --report: the plugin upgrades", () => {
  it("lists each upgrade that moved the plugin or failed since the report's time, from both jobs' receipts", async () => {
    const forge = fakeForge("");
    forge.write("login", "drive-bot");
    forge.write("search.json", { items: [] });
    const updated: ScheduledUpgrade = {
      outcome: "updated",
      detail: "claude 0.114.0 -> 0.115.0",
      at: hoursAgo(6),
      from: "0.114.0",
      to: "0.115.0",
    };
    const failed: ScheduledUpgrade = {
      outcome: "failed",
      detail:
        "claude plugin update jig@jig --scope user exited 1: network down",
      at: hoursAgo(2),
    };
    tickReceipt(forge, updated);
    gcReceipt(forge, failed);
    gcReceipt(forge, {
      outcome: "withheld",
      detail: "upgrade.every is 1h",
      at: hoursAgo(1),
    });
    tickReceipt(forge, {
      outcome: "unchanged",
      detail: "claude at 0.115.0",
      at: hoursAgo(3),
    });
    tickReceipt(forge, {
      ...updated,
      at: hoursAgo(30),
      from: "0.113.0",
      to: "0.114.0",
    });

    const json = await runIn(forge, join(SCRIPTS, "drives.ts"), [
      "--report",
      "--json",
      "--since",
      "12h",
    ]);
    expectSpawnExit(json, 0);
    const out = JSON.parse(json.stdout);
    expect(out.upgrades).toEqual([
      {
        at: updated.at,
        job: "dispatch",
        outcome: "updated",
        line: "0.114.0 -> 0.115.0",
      },
      {
        at: failed.at,
        job: "gc",
        outcome: "failed",
        line: `failed: ${failed.detail}`,
      },
    ]);
    const text = await runIn(forge, join(SCRIPTS, "drives.ts"), [
      "--report",
      "--since",
      "12h",
    ]);
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain(
      `Plugin upgrades the timers ran on this machine (from the jobs' receipts):\n  ${updated.at} dispatch: 0.114.0 -> 0.115.0\n  ${failed.at} gc: failed: ${failed.detail}\n`,
    );
  });
});
