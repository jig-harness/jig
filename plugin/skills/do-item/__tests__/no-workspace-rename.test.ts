/**
 * A workspace keeps the name it was created with: no shipped script or skill
 * text renames an Orca worktree (`worktree set --display-name`) or a Herdr
 * workspace (`workspace rename`). The dispatcher names a workspace once, at
 * creation (`--name`), which is not a rename.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN = join(import.meta.dir, "..", "..", "..");
const RENAMES = [/--display-name/, /workspace["',\s]+rename\b/];

test("no shipped plugin file renames a workspace", () => {
  const glob = new Bun.Glob("**/*.{ts,md,json,yaml}");
  const offenders: string[] = [];
  for (const path of glob.scanSync({ cwd: PLUGIN })) {
    const parts = path.split(/[\\/]/);
    if (parts.includes("__tests__") || parts.includes("node_modules")) continue;
    const text = readFileSync(join(PLUGIN, path), "utf8");
    if (RENAMES.some((pattern) => pattern.test(text))) offenders.push(path);
  }
  expect(offenders).toEqual([]);
});
