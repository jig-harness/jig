/**
 * `drives.ts --report`: the plugin upgrades the timers ran on this machine
 * since the report's time, from collection's and the dispatcher's receipts.
 * An upgrade that moved the plugin and one that failed are listed, each
 * once; one withheld, skipped or unchanged, or one from before the report's
 * time, is not.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
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
  const path = writeTick(
    {
      version: 1,
      runId: newRunId(Temporal.Instant.from(upgrade.at)),
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
  // A dispatcher receipt is dated by its file time, its publication.
  utimesSync(path, new Date(upgrade.at), new Date(upgrade.at));
}

describe("drives.ts --report: the plugin upgrades", () => {
  it("names a dispatch receipt that does not read once, with why", async () => {
    const forge = fakeForge("");
    forge.write("login", "drive-bot");
    forge.write("search.json", { items: [] });
    const root = join(
      forge.env.HOME as string,
      ".local",
      "state",
      "jig",
      "dispatch",
    );
    roots.push(root);
    const at = new Date(Date.now() - 3_600_000);
    const day = join(root, "receipts", at.toISOString().slice(0, 10));
    mkdirSync(day, { recursive: true });
    const bad = join(
      day,
      `${newRunId(Temporal.Instant.fromEpochMilliseconds(at.getTime()))}.json`,
    );
    writeFileSync(bad, "{ not json");
    const json = await runIn(forge, join(SCRIPTS, "drives.ts"), [
      "--report",
      "--json",
      "--since",
      "12h",
    ]);
    expectSpawnExit(json, 0);
    const named = (JSON.parse(json.stdout).unread as string[]).filter((u) =>
      u.includes(bad),
    );
    expect(named).toHaveLength(1);
    expect(named[0]).toMatch(/does not read \(SyntaxError: /);
  });

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
    // The same failure, every tick for a while: one entry.
    const repeated =
      "/home/x/.jig/jig.yaml: upgrade.every must be a whole number";
    const times = [5, 4.5, 4].map(hoursAgo);
    for (const at of times)
      tickReceipt(forge, { outcome: "failed", detail: repeated, at });
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
        last: updated.at,
        count: 1,
        job: "dispatch",
        outcome: "updated",
        line: "0.114.0 -> 0.115.0",
      },
      {
        at: times[0],
        last: times[2],
        count: 3,
        job: "dispatch",
        outcome: "failed",
        line: `failed: ${repeated}`,
      },
      {
        at: failed.at,
        last: failed.at,
        count: 1,
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
      `Plugin upgrades the timers ran on this machine (from the jobs' receipts):\n  ${updated.at} dispatch: 0.114.0 -> 0.115.0\n  ${times[0]} to ${times[2]} dispatch: failed: ${repeated} (3 times)\n  ${failed.at} gc: failed: ${failed.detail}\n`,
    );
  });
});
