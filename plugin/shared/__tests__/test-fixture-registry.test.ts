import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { Defect } from "../errors.ts";
import { encodeIdentity, ownIdentity } from "../liveness.ts";
import {
  acknowledgeFixtureLaunch,
  beginFixtureLaunch,
  readClosedFixtureMembership,
  registerFixtureScope,
} from "../test-fixture-registry.ts";

const MODULE = resolve(import.meta.dir, "../test-fixture-registry.ts");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "fixture-ack-"));
  directories.push(base);
  const root = join(base, "scope");
  mkdirSync(root);
  const parent = registerFixtureScope(root, undefined, join(base, "registry"));
  if (!parent.ok) throw new Defect(parent.failure.reason);
  const launch = beginFixtureLaunch(parent.value, true);
  if (!launch.ok) throw new Defect(launch.failure.reason);
  const config = join(base, "bunfig.toml");
  writeFileSync(config, "");
  const source = `const {acknowledgeFixtureLaunch}=await import(${JSON.stringify(MODULE)}); console.log(JSON.stringify(acknowledgeFixtureLaunch(${JSON.stringify(launch.value)})));`;
  return {
    base,
    launch: launch.value,
    source,
    args: (code: string) => [
      process.execPath,
      "--no-env-file",
      `--config=${config}`,
      "-e",
      code,
    ],
  };
}
test("an acknowledgement is idempotent only for its own process", () => {
  const f = fixture();
  expect(acknowledgeFixtureLaunch(f.launch)).toEqual({ ok: true, value: true });
  expect(acknowledgeFixtureLaunch(f.launch)).toEqual({ ok: true, value: true });
  const other = Bun.spawnSync(f.args(f.source), {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20000,
  });
  expectSpawnExit(other, 0);
  expect(JSON.parse(other.stdout.toString())).toMatchObject({
    ok: false,
    failure: { code: "fixture-acknowledgement" },
  });
});
test("an unfinished publication cannot transfer its immutable claim to another process", () => {
  const f = fixture();
  writeFileSync(
    join(f.launch.registry, "nodes", `${f.launch.node}.claim`),
    encodeIdentity(ownIdentity()),
  );
  const other = Bun.spawnSync(f.args(f.source), {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20000,
  });
  expectSpawnExit(other, 0);
  expect(JSON.parse(other.stdout.toString())).toMatchObject({
    ok: false,
    failure: { code: "fixture-acknowledgement" },
  });
});
test("a registered child without its durable claim leaves membership unverified", () => {
  const f = fixture();
  expect(acknowledgeFixtureLaunch(f.launch)).toEqual({ ok: true, value: true });
  rmSync(join(f.launch.registry, "nodes", `${f.launch.node}.claim`));
  expect(
    readClosedFixtureMembership(join(f.base, "scope"), f.launch.registry),
  ).toMatchObject({
    ok: false,
    failure: { code: "fixture-proof" },
  });
});
test("concurrent acknowledgements cannot overwrite another process's membership", async () => {
  const f = fixture();
  const barrier = join(f.base, "barrier");
  const source = `const deadline=Date.now()+10000;while(!(await Bun.file(${JSON.stringify(barrier)}).exists())){if(Date.now()>deadline)throw new Error('barrier deadline');await Bun.sleep(10);} ${f.source}`;
  const options = {
    env: { ...process.env },
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  };
  const first = Bun.spawn(f.args(source), options);
  const second = Bun.spawn(f.args(source), options);
  writeFileSync(barrier, "");
  const results = await Promise.all(
    [first, second].map(async (child) => {
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      const exitCode = await child.exited;
      expectSpawnExit({ exitCode, stdout, stderr }, 0);
      return JSON.parse(stdout).ok;
    }),
  );
  expect(results.sort()).toEqual([false, true]);
}, 30000);
