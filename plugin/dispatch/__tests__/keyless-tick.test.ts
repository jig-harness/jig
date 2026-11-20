/**
 * A tick with no Linear key in its environment and a `linear` client that is
 * not logged in fails closed for the tracker: the client is asked once, the
 * receipt names the missing key once as the tracker's reason, and the tick
 * exits with the `unauthorized` class's status.
 */
import { afterEach, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { EXIT_OF_CLASS } from "../../shared/outbound/failure.ts";
import type { TickReceipt } from "../receipts.ts";
import { type World, world } from "./fixtures.ts";
import { account, machineFile } from "./launch-fixtures.ts";

const DISPATCH = resolve(import.meta.dir, "..");
let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A logged-out `linear` client: every call is logged and answered as the client answers with no API key. */
const LOGGED_OUT = `#!/usr/bin/env bun
const fs = require("node:fs");
fs.appendFileSync(process.env.DISPATCH_FAKE_DIR + "/linear-calls.log", process.argv.slice(2, 3).join(" ").replace(/\\s+/g, " ").slice(0, 60) + "\\n");
process.stderr.write("✗ API request failed: No API key configured\\n");
process.exit(1);
`;

function keylessWorld(): World {
  const w = world();
  current = w;
  writeFakeProgram(join(w.root, "bin", "linear"), LOGGED_OUT);
  delete w.env.LINEAR_API_KEY;
  delete w.env.LINEAR_API_TOKEN;
  w.setConfig(`issue_tracker:
  adapter: linear
  team: ENG
dispatch:
  identity: factory-bot
`);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["pickup"]);
  return w;
}

function entry(w: World): string {
  const path = join(w.root, "keyless-tick.ts");
  writeFileSync(
    path,
    `const { readMachineConfig } = await import(${JSON.stringify(`${DISPATCH}/lib/machine-config.ts`)});
const { runTick } = await import(${JSON.stringify(`${DISPATCH}/tick.ts`)});
const read = readMachineConfig();
if (!read.ok || read.value === null) throw new Error("the fixture needs a machine file");
const result = await runTick({ repos: [process.cwd()], apply: true, machine: read.value });
if ("held" in result) throw new Error("fixture tick lock held");
console.log(JSON.stringify(result.receipt));
process.exit(result.receipt.exitStatus);
`,
  );
  return path;
}

it("asks a logged-out client once, names the missing key once and exits as unauthorized", async () => {
  const w = keylessWorld();
  const r = await w.dispatch([], entry(w));
  expectSpawnExit(r, EXIT_OF_CLASS.unauthorized);
  const receipt = JSON.parse(r.stdout) as TickReceipt;
  const log = join(w.dir, "linear-calls.log");
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean)
    : [];
  expect(calls.length).toBeLessThanOrEqual(1);
  const text = JSON.stringify(receipt);
  expect(text.split("no Linear key configured")).toHaveLength(2);
  expect(receipt.noCredential).toEqual([
    expect.objectContaining({
      system: "linear",
      class: "unauthorized",
      reason: "no Linear key configured",
      repos: ["example-org/example-repo"],
    }),
  ]);
  const remedy = receipt.noCredential?.[0]?.remedy ?? "";
  for (const named of ["LINEAR_API_KEY", "LINEAR_API_TOKEN", "`linear`"])
    expect(remedy).toContain(named);
  // No repository's turn fails for it, and the tick's own log says it once.
  expect(receipt.repos[0]?.records.every((r) => r.ok)).toBe(true);
  expect(r.stderr.split("no Linear key configured")).toHaveLength(2);
  // The line marks the repository's tracker part as kept: no tick read it with a credential yet.
  const line = await w.dispatch(["line", "--json"]);
  expectSpawnExit(line, 0);
  const repo = JSON.parse(line.stdout).value.line.repos[0];
  expect(repo.trackerKept).toEqual({
    readAt: null,
    reason: "no Linear key configured",
  });
}, 60_000);
