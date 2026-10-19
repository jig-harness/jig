import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it("retries a Windows sharing violation before releasing a lock generation", () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-sharing-"));
  dirs.push(dir);
  const lockModule = fileURLToPath(
    new URL("../scripts/lib/state/lock.ts", import.meta.url),
  );
  const retryModule = fileURLToPath(
    new URL("../../../shared/rename-with-retry.ts", import.meta.url),
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import { mock } from 'bun:test';
    import * as fs from 'node:fs';
    const retry = await import(${JSON.stringify(retryModule)});
    const retryRename = retry.renameWithRetry;
    const retryMkdir = retry.mkdirWithRetry;
    const realRename = fs.renameSync;
    const realMkdir = fs.mkdirSync;
    const file = ${JSON.stringify(join(dir, "state.json"))};
    let failures = 0;
    let mkdirFailures = 0;
    mock.module(${JSON.stringify(retryModule)}, () => ({
      ...retry,
      renameWithRetry: (source, destination) => retryRename(source, destination, {
        platform: 'win32', sleep: () => {},
        rename: (source, destination) => {
          if (source === file + '.lock' && failures++ === 0)
            throw Object.assign(new Error('reader holds directory'), { code: 'EACCES' });
          realRename(source, destination);
        },
      }),
      mkdirWithRetry: (path) => retryMkdir(path, {
        platform: 'win32', sleep: () => {},
        mkdir: (path) => {
          if (path === file + '.lock' && mkdirFailures++ === 0)
            throw Object.assign(new Error('pending deletion'), { code: 'EPERM' });
          realMkdir(path);
        },
      }),
    }));
    const { createLock } = await import(${JSON.stringify(lockModule)});
    using lock = createLock(file, 'sharing test', '1');
    await lock.acquire(0);
    lock.release();
    if (fs.existsSync(file + '.lock')) throw new Error('release stranded its generation');
    if (failures < 2 || mkdirFailures < 2) throw new Error('filesystem retries did not run');
  `,
    ],
    { env: { ...process.env, DRIVE_PR_LOCK_TIMEOUT: "0" } },
  );
  expectSpawnExit(result, 0);
  expect(result.stderr.toString()).not.toContain("sharing test:");
});

it("reports an exhausted release error instead of silently claiming contention", () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-release-error-"));
  dirs.push(dir);
  const lockModule = fileURLToPath(
    new URL("../scripts/lib/state/lock.ts", import.meta.url),
  );
  const retryModule = fileURLToPath(
    new URL("../../../shared/rename-with-retry.ts", import.meta.url),
  );
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    import { mock } from 'bun:test';
    import * as fs from 'node:fs';
    const retry = await import(${JSON.stringify(retryModule)});
    const retryRename = retry.renameWithRetry;
    const realRename = fs.renameSync;
    const file = ${JSON.stringify(join(dir, "state.json"))};
    let attempts = 0;
    mock.module(${JSON.stringify(retryModule)}, () => ({
      ...retry,
      renameWithRetry: (source, destination) => retryRename(source, destination, {
        platform: 'win32', sleep: () => {},
        rename: (source, destination) => {
          if (source === file + '.lock') {
            attempts++;
            throw Object.assign(new Error('reader holds directory'), { code: 'EACCES' });
          }
          realRename(source, destination);
        },
      }),
    }));
    const { createLock } = await import(${JSON.stringify(lockModule)});
    using lock = createLock(file, 'release error', '1');
    await lock.acquire();
    lock.release();
    if (!fs.existsSync(file + '.lock') || attempts !== 5) throw new Error('unsafe or unbounded release');
  `,
  ]);
  expectSpawnExit(result, 0);
  expect(result.stderr.toString()).toContain("EACCES");
});

it("restores a successor generation even when the restore meets a sharing violation", () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-restore-sharing-"));
  dirs.push(dir);
  const lockModule = fileURLToPath(
    new URL("../scripts/lib/state/lock.ts", import.meta.url),
  );
  const retryModule = fileURLToPath(
    new URL("../../../shared/rename-with-retry.ts", import.meta.url),
  );
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    import { mock } from 'bun:test';
    import * as fs from 'node:fs';
    import { join } from 'node:path';
    const retry = await import(${JSON.stringify(retryModule)});
    const retryRename = retry.renameWithRetry;
    const realRename = fs.renameSync;
    const file = ${JSON.stringify(join(dir, "state.json"))};
    let restoreAttempts = 0;
    mock.module(${JSON.stringify(retryModule)}, () => ({
      ...retry,
      renameWithRetry: (source, destination) => retryRename(source, destination, {
        platform: 'win32', sleep: () => {},
        rename: (source, destination) => {
          if (destination === file + '.lock' && restoreAttempts++ === 0)
            throw Object.assign(new Error('restore target pending deletion'), { code: 'EBUSY' });
          realRename(source, destination);
        },
      }),
    }));
    const { createLock } = await import(${JSON.stringify(lockModule)});
    using lock = createLock(file, 'restore sharing', '1');
    await lock.acquire();
    fs.rmSync(file + '.lock', { recursive: true });
    fs.mkdirSync(file + '.lock');
    fs.writeFileSync(join(file + '.lock', 'owner.successor'), '');
    lock.release();
    if (!fs.existsSync(join(file + '.lock', 'owner.successor')) || restoreAttempts !== 2)
      throw new Error('successor generation was not restored');
  `,
  ]);
  expectSpawnExit(result, 0);
  expect(result.stderr.toString()).not.toContain("could not be restored");
});

it("keeps a Windows directory fence instead of compacting it to a replaceable file", () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-windows-fence-"));
  dirs.push(dir);
  const lockModule = fileURLToPath(
    new URL("../scripts/lib/state/lock.ts", import.meta.url),
  );
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `
    import * as fs from 'node:fs';
    import { join } from 'node:path';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { sweepLockQuarantine } = await import(${JSON.stringify(lockModule)});
    const file = ${JSON.stringify(join(dir, "state.json"))};
    const fence = file + '.lock.stale.owner.' + 'a'.repeat(24);
    fs.mkdirSync(fence);
    fs.writeFileSync(join(fence, 'tombstone'), 'broken');
    sweepLockQuarantine(file);
    if (!fs.statSync(fence).isDirectory() || !fs.existsSync(join(fence, 'tombstone')))
      throw new Error('Windows fence was compacted to a replaceable file');
  `,
  ]);
  expectSpawnExit(result, 0);
  expect(result.stderr.toString()).toBe("");
});
