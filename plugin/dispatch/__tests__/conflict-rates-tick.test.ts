/**
 * dispatch: the work after the act phase. Once a tick has written its
 * receipt and given up the act lock and every observe lock, it hands the
 * repositories it acted on to the conflict rates' refresh, so a slow replay
 * never delays a launch or another tick; a defect there leaves the tick's
 * receipt and exit as they were. Each tick runs in a child with its own home
 * (fixtures.ts), the locks as real files in its state directory.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { SLUG, type World, world } from "./fixtures.ts";

const DISPATCH = resolve(import.meta.dir, "..");

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

/**
 * A tick whose work after the act phase records what it sees: whether the
 * act lock and any observe lock are still held, how many receipts are
 * written, and what it was handed. With `defect`, it then throws.
 */
const tickScript = (defect: boolean) => `
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTick } from ${JSON.stringify(`${DISPATCH}/tick.ts`)};
import { stateRoot } from ${JSON.stringify(`${DISPATCH}/receipts.ts`)};
const F = process.env.DISPATCH_FAKE_DIR;
const count = (dir, suffix) => existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(suffix)).length : 0;
const result = await runTick({
  repos: process.argv.slice(2),
  followupSince: "2026-10-30T00:00:00Z",
  afterAct: async (repos, tick) => {
    const root = stateRoot();
    writeFileSync(F + "/after-act.json", JSON.stringify({
      actLock: existsSync(join(root, "tick.lock")),
      observeLocks: count(join(root, "observe"), ".lock"),
      receipts: count(join(root, "receipts"), ".json"),
      repos,
      apply: tick.apply,
      caller: tick.caller,
    }));
    if (${defect}) throw new Error("after the act phase");
  },
});
if ("held" in result) { console.error(result.held); process.exit(3); }
console.log(JSON.stringify(result.receipt));
process.exit(result.receipt.exitStatus);
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function entry(w: World, name: string, script: string): string {
  const path = join(w.root, name);
  writeFileSync(path, script);
  return path;
}

describe("the work after the act phase", () => {
  it("runs once the receipt is written and every lock is given up, with the repositories the tick acted on", async () => {
    const w = world();
    current = w;
    w.setConfig(CONFIG);
    const r = await w.dispatch(
      [w.repo],
      entry(w, "tick.ts", tickScript(false)),
    );
    expectSpawnExit(r, 0);
    const receipt = JSON.parse(r.stdout) as { runId: string };
    const seen = JSON.parse(
      readFileSync(join(w.dir, "after-act.json"), "utf8"),
    );
    expect(seen).toMatchObject({
      actLock: false,
      observeLocks: 0,
      receipts: 1,
      apply: false,
      caller: `tick:${receipt.runId}`,
    });
    expect(seen.repos).toEqual([
      { slug: SLUG, path: w.repo, listed: false, stages: [] },
    ]);
  }, 60_000);

  it("leaves the tick's receipt and exit as they were when it fails", async () => {
    const w = world();
    current = w;
    w.setConfig(CONFIG);
    const r = await w.dispatch([w.repo], entry(w, "tick.ts", tickScript(true)));
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("a defect stopped the work after the act phase");
    expect(JSON.parse(r.stdout).completed).toBe(true);
  }, 60_000);
});
