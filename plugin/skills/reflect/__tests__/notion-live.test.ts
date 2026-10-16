/**
 * The Notion store against Notion itself: opt-in, since it needs a token
 * and writes to a workspace. Set NOTION_TOKEN to an internal integration's
 * secret and JIG_NOTION_LIVE_PARENT to a scratch page shared with it; each
 * run creates a new database under that page with `init`, runs the
 * conformance suite against it, and leaves it there for a person to look at
 * or delete.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, tsArgv } from "../../../shared/proc.ts";
import { runConformance } from "../scripts/store-contract.ts";

const NOTION_STORE = join(import.meta.dir, "..", "scripts", "notion-store.ts");
const token = process.env.NOTION_TOKEN?.trim() ?? "";
const parent = process.env.JIG_NOTION_LIVE_PARENT?.trim() ?? "";
const live = token !== "" && parent !== "";

let dir = "";
beforeAll(() => {
  if (live)
    dir = realpathSync(mkdtempSync(join(tmpdir(), "reflect-notion-live-")));
});
afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

it.skipIf(!live)(
  "passes the conformance suite against a database init creates in Notion",
  async () => {
    // Notion itself, at its own pace, with a cache of this run's own.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && !key.startsWith("JIG_NOTION_"))
        env[key] = value;
    env.JIG_HOME = join(dir, "jig-home");
    const created = await run(
      tsArgv(NOTION_STORE, ["init", "--parent", parent]),
      {
        env,
        timeoutSec: 120,
      },
    );
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    const database = /database: (\S+)/.exec(created.stdout)?.[1];
    if (database === undefined) throw new Error(created.stdout);
    const results = await runConformance(
      tsArgv(NOTION_STORE, ["--database", database]),
      300,
      env,
    );
    expect(results.filter((result) => !result.ok)).toEqual([]);
  },
  1_800_000,
);
