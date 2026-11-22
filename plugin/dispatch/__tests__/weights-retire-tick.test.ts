/**
 * A tick that applies retires the host's stale weights notice records under
 * the act lock, whether or not any repository notifies, reading the weights
 * file as it stands once the lock is held.
 */
import { afterEach, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import { storedWeightsKeys, suppress } from "../lib/notice-records.ts";
import { WEIGHTS_SKIP_KEY } from "../lib/failure-notices.ts";
import { type World, world } from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";

const DISPATCH = resolve(import.meta.dir, "..");
let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function entry(w: World): string {
  const path = join(w.root, "weights-retire-tick.ts");
  writeFileSync(
    path,
    `const { readMachineConfig } = await import(${JSON.stringify(`${DISPATCH}/lib/machine-config.ts`)});
const { runTick } = await import(${JSON.stringify(`${DISPATCH}/tick.ts`)});
const read = readMachineConfig();
if (!read.ok || read.value === null) throw new Error("the fixture needs a machine file");
const result = await runTick({ repos: [process.cwd()], apply: true, machine: read.value });
if ("held" in result) throw new Error("fixture tick lock held");
process.exit(0);
`,
  );
  return path;
}

it("retires a stale weights record in an apply tick no repository notifies in", async () => {
  const w = world();
  current = w;
  machineFile(
    w,
    [account(w, "a", "a@example.com"), account(w, "b", "b@example.com")],
    {},
    ["pickup"],
  );
  const file = join(w.env.JIG_HOME ?? "", "weights.local.yaml");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "accounts: {a: 0}");
  const root = dispatchState(w);
  mkdirSync(root, { recursive: true });
  suppress(
    "orca-card",
    {
      repo: "/elsewhere",
      key: `${WEIGHTS_SKIP_KEY}old`,
      target: "t",
      workspace: "w",
      at: "2026-11-21T00:00:00Z",
      lasting: false,
    },
    null,
    root,
    false,
  );
  expect(storedWeightsKeys(stateDb(root), WEIGHTS_SKIP_KEY).size).toBe(1);
  closeStateDb(root);
  expectSpawnExit(await w.dispatch([], entry(w)), 0);
  expect(storedWeightsKeys(stateDb(root), WEIGHTS_SKIP_KEY).size).toBe(0);
  closeStateDb(root);
}, 60_000);
