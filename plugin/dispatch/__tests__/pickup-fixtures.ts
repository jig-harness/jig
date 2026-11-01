/**
 * What the pickup tests add to a tick's world: an origin for the clone, so
 * a new item branch is cut from `origin/HEAD` as on a real host; the tick
 * run with an Orca runtime that binds interactive sessions; and what the
 * fakes recorded.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { TickReceipt } from "../receipts.ts";
import type { World } from "./fixtures.ts";

const DISPATCH = resolve(import.meta.dir, "..");

/**
 * A tick with `--apply` whose Orca runtime reports that it binds an
 * interactive session to its account: what the tick does once such a
 * binding exists, with nothing in the tick changed. It prints the receipt
 * and exits with the tick's status.
 */
const BOUND_TICK = `import { readMachineConfig } from ${JSON.stringify(`${DISPATCH}/lib/machine-config.ts`)};
import { orcaRuntime } from ${JSON.stringify(`${DISPATCH}/lib/runtime/orca.ts`)};
import { runTick } from ${JSON.stringify(`${DISPATCH}/tick.ts`)};
const machine = readMachineConfig();
if (machine === null) throw new Error("the bound tick needs a machine file");
const result = await runTick({
  repos: machine.repositories.map((r) => r.path),
  apply: true,
  machine,
  runtime: orcaRuntime(
    { runtimeTimeoutMs: machine.runtimeTimeoutMs, workspaceTimeoutMs: machine.workspaceTimeoutMs },
    { ok: true },
  ),
});
if ("held" in result) { console.error("another tick holds the lock: " + result.held); process.exit(3); }
console.log(JSON.stringify(result.receipt, null, 2));
process.exit(result.receipt.exitStatus);
`;

/** The bound tick's script in the world's root. */
function boundTick(w: World): string {
  const path = join(w.root, "bound-tick.ts");
  if (!existsSync(path)) writeFileSync(path, BOUND_TICK);
  return path;
}

/** Give the world's clone a bare origin with `main` as its `origin/HEAD`. */
export function withOrigin(w: World): void {
  const origin = join(w.root, "origin.git");
  for (const args of [
    ["clone", "-q", "--bare", w.repo, origin],
    ["-C", w.repo, "remote", "add", "origin", origin],
    ["-C", w.repo, "fetch", "-q", "origin"],
    ["-C", w.repo, "remote", "set-head", "origin", "main"],
  ]) {
    const r = Bun.spawnSync(["git", ...args], {
      env: w.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(r, 0);
  }
}

/** One tick with `--apply`: through `jig dispatch`, or with Orca bound when `bound`. */
export async function applyTick(
  w: World,
  bound: boolean,
): Promise<TickReceipt> {
  const r = bound
    ? await w.dispatch([], boundTick(w))
    : await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

/** The Orca calls the fake answered whose first two words are `verb`. */
export function orcaCalls(w: World, ...verb: string[]): string[][] {
  const path = join(w.dir, "orca-calls.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => verb.every((v, i) => args[i] === v));
}

/** The sessions the fake Claude Code recorded. */
export function claudeRuns(w: World): Array<{
  argv: string[];
  cwd: string;
  configDir: string | null;
  token: string | null;
}> {
  const path = join(w.dir, "claude-runs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
