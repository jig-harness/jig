import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

const shared = resolve(import.meta.dir, "..");
const foreground = resolve(
  import.meta.dir,
  "../../skills/drive-pr/scripts/foreground-wait.ts",
);

function fixture(proc: string): string {
  return `
    import { mock } from 'bun:test';
    import { readFileSync, readdirSync } from 'node:fs';
    import { join } from 'node:path';
    const lifecyclePath = ${JSON.stringify(join(shared, "windows-process.ts"))};
    const original = (await import(lifecyclePath)).windowsProcessLifecycle;
    if (process.platform !== 'win32') {
      // Exercise the Windows lifecycle with this host's real process provider.
      // The mutation is confined to this test's subprocess and restored before spawning.
      mock.module(lifecyclePath, () => ({windowsProcessLifecycle(env) {
        const platform = process.platform;
        try {
          Object.defineProperty(process, 'platform', {value:'win32',configurable:true});
          return original(env);
        } finally {
          Object.defineProperty(process, 'platform', {value:platform,configurable:true});
        }
      }}));
    }
    const { run } = await import(${JSON.stringify(proc)});
    const parent = ${JSON.stringify(`
      const launched = Bun.spawnSync([process.execPath, ${JSON.stringify(foreground)}, 'launch', '--', process.execPath, '-e', 'setInterval(() => {},1000)'], {stdout:'pipe',stderr:'pipe'});
      if (launched.exitCode !== 0) { process.stderr.write(launched.stderr); process.exit(1); }
    `)};
    const result = await run([process.execPath, '-e', parent], {reapGroup:true});
    if (result.code !== 0 || result.groupSurvived !== true) throw new Error(JSON.stringify(result));
    const root = join(process.cwd(), '.context', 'foreground-wait');
    const generation = readdirSync(root).find(name => name.startsWith('gen-'));
    const runner = Number(readFileSync(join(root,generation,'runner.pid'),'utf8'));
    const { processTable } = await import(${JSON.stringify(join(shared, "process-table.ts"))});
    const rows = await processTable();
    if (rows === null || rows.some(row => row.pid === runner && !row.stat.startsWith('Z'))) throw new Error('registered runner survived reap');
    console.log('registered runner reaped; groupSurvived=true');
  `;
}

test("Windows normal-exit reaping reports registered runners in groupSurvived", () => {
  const cwd = mkdtempSync(join(tmpdir(), "windows-run-reap-"));
  try {
    const result = Bun.spawnSync(
      [process.execPath, "-e", fixture(join(shared, "proc.ts"))],
      {
        cwd,
        env: { ...process.env, JIG_PROCESS_REGISTRY_DIR: undefined },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      },
    );
    expectSpawnExit(result, 0);
    expect(result.stdout.toString()).toContain(
      "registered runner reaped; groupSurvived=true",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 65_000);
