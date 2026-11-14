/**
 * dispatch: a tick whose forge refuses or does not answer. A rate-limited
 * repository does not fail the tick, and its report shows the forge's last
 * reading with its age; a forge that did not answer gets no second request
 * in the same tick, and the next tick sends it one probe before it reads
 * on. Each tick runs as the installed command in a child with its own home.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { TickReceipt } from "../receipts.ts";
import { mergedPr, openPr, SLUG, type World, world } from "./fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
  followup_command: /followup
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setPrs("open", [openPr(7, "feature/7-open")]);
  w.setPrs("merged", [mergedPr(5, "feature/5-merged", "2026-10-30T12:00:00Z")]);
  return w;
}

/** One tick of the world's repository; its exit and its receipt. */
async function tick(w: World): Promise<{ exit: number; receipt: TickReceipt }> {
  const r = await w.dispatch([
    "--repo",
    w.repo,
    "--followup-since",
    "2026-10-30T00:00:00Z",
    "--json",
  ]);
  expectSpawnExit(r, r.exitCode === 0 ? 0 : 1);
  return { exit: r.exitCode ?? -1, receipt: JSON.parse(r.stdout) };
}

/** The `gh` calls the fake forge received since the last time this was asked, emptied. */
function calls(w: World): string[] {
  const log = join(w.dir, "gh-calls.log");
  if (!existsSync(log)) return [];
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
  rmSync(log);
  return lines;
}

/** The holds a tick left for the next one, by system. */
function unanswered(w: World): Record<string, unknown> {
  const path = join(
    w.home,
    ".local",
    "state",
    "jig",
    "dispatch",
    "unanswered.json",
  );
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

describe("a forge that refuses or does not answer", () => {
  it("lets a tick with a rate-limited repository exit 0, showing the last reading with its age", async () => {
    const w = fixture();
    const before = await tick(w);
    expect(before.exit).toBe(0);
    const record = before.receipt.repos[0]?.records.find(
      (r) => r.record === "forge",
    );
    expect(record?.ok).toBe(true);

    writeFileSync(join(w.dir, "forge-rate-limited"), "");
    const limited = await tick(w);
    expect(limited.exit).toBe(0);
    const repo = limited.receipt.repos[0];
    expect(repo?.refusedBy?.class).toBe("rate-limited");
    expect(repo?.refusedBy?.until).toBeString();
    expect(repo?.refused).toContain("rate limit");
    expect(repo?.refused).toMatch(
      /the last reading, of \d{4}-\d\d-\d\dT[\d:.]+Z \(\d+m old\): 1 open pull request\(s\)/,
    );
  });

  it("fails the tick for a forge that refused the credential, which waiting does not clear", async () => {
    const w = fixture();
    writeFileSync(join(w.dir, "forge-unauthorized"), "");
    const refused = await tick(w);
    expect(refused.exit).toBe(1);
    expect(refused.receipt.repos[0]?.refusedBy?.class).toBe("unauthorized");
  });

  it("sends no second request to a forge that did not answer in a tick, and one probe in the next", async () => {
    const w = fixture();
    writeFileSync(join(w.dir, "forge-unreachable"), "");
    const first = await tick(w);
    expect(first.exit).toBe(0);
    // The budget read and the repository's query leave together; the reads
    // that follow a failed query (the repository view, the listings) never do.
    const sent = calls(w);
    expect(sent.length).toBeLessThanOrEqual(2);
    expect(sent.some((c) => c.includes("DispatchRepository"))).toBe(true);
    expect(sent.some((c) => /^(repo view|pr list)/.test(c))).toBe(false);
    expect(first.receipt.repos[0]?.refusedBy?.class).toBe("unreachable");
    expect(first.receipt.unanswered?.[0]).toMatchObject({
      system: "github",
      class: "unreachable",
    });
    expect(Object.keys(unanswered(w))).toEqual(["github"]);

    // Still down: the next tick's probe is its only request.
    const second = await tick(w);
    expect(second.exit).toBe(0);
    expect(calls(w)).toHaveLength(1);

    // Back: the probe is answered and the tick reads on, releasing the hold.
    rmSync(join(w.dir, "forge-unreachable"));
    const third = await tick(w);
    expect(third.exit).toBe(0);
    expect(calls(w).length).toBeGreaterThan(1);
    expect(third.receipt.repos[0]?.refused).toBeNull();
    expect(third.receipt.unanswered).toBeUndefined();
    expect(unanswered(w)).toEqual({});
  });
});
