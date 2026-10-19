import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";

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
    let elapsed = 0;
    mock.module(${JSON.stringify(retryModule)}, () => ({
      ...retry,
      renameWithRetry: (source, destination) => retryRename(source, destination, {
        platform: 'win32', now: () => elapsed, random: () => 0, sleep: (ms) => { elapsed += ms; },
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
    if (!fs.existsSync(file + '.lock') || attempts !== 401) throw new Error('unsafe or unbounded release');
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

it("restores a fresh holder and releases the recovery gate after the acquisition deadline expires", () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-expired-restore-"));
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
    fs.mkdirSync(file + '.lock');
    fs.writeFileSync(join(file + '.lock', 'owner.original'), '');
    const old = new Date(Date.now() - 20 * 60_000);
    fs.utimesSync(file + '.lock', old, old);
    let restoreAttempts = 0;
    let releaseAttempts = 0;
    let replaced = false;
    mock.module(${JSON.stringify(retryModule)}, () => ({
      ...retry,
      renameWithRetry: (source, destination, options) => retryRename(source, destination, {
        ...options, platform: 'win32', sleep: () => {},
        rename: (source, destination) => {
          if (source === file + '.lock' && !replaced) {
            replaced = true;
            fs.rmSync(source, { recursive: true });
            fs.mkdirSync(source);
            fs.writeFileSync(join(source, 'owner.foreign'), '');
            realRename(source, destination);
            Bun.sleepSync(80);
            return;
          }
          if (destination === file + '.lock' && restoreAttempts++ === 0)
            throw Object.assign(new Error('restore sharing violation'), { code: 'EBUSY' });
          if (source === file + '.lock.recovering' && releaseAttempts++ === 0)
            throw Object.assign(new Error('release sharing violation'), { code: 'EBUSY' });
          realRename(source, destination);
        },
      }),
    }));
    const { createLock, LockAcquireTimeoutError } = await import(${JSON.stringify(lockModule)});
    using lock = createLock(file, 'expired cleanup', '1');
    try { await lock.acquire(0.05); throw new Error('foreign holder was acquired'); }
    catch (error) { if (!(error instanceof LockAcquireTimeoutError)) throw error; }
    if (!fs.existsSync(join(file + '.lock', 'owner.foreign')) || restoreAttempts !== 2)
      throw new Error('expired acquisition deadline prevented foreign restoration');
    if (fs.existsSync(file + '.lock.recovering') || releaseAttempts !== 2)
      throw new Error('expired acquisition deadline prevented recovery gate release');
  `,
  ]);
  expectSpawnExit(result, 0);
  expect(result.stderr.toString()).not.toContain("could not be restored");
});

/** Exercise native replacement on Windows, and its filesystem contract elsewhere. */
function windowsFenceScenario(body: string): void {
  const dir = mkdtempSync(join(tmpdir(), "windows-fence-repair-"));
  dirs.push(dir);
  const emulate =
    byPlatform(
      "POSIX refuses directory-over-file replacement; Windows permits it",
      {
        windows: "native",
        posix: "emulate",
      },
    ) === "emulate";
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
    import assert from 'node:assert/strict';
    import * as fs from 'node:fs';
    import { join, basename } from 'node:path';
    const retry = await import(${JSON.stringify(retryModule)});
    const retryRename = retry.renameWithRetry;
    const realRename = fs.renameSync;
    const dir = ${JSON.stringify(dir)};
    const file = join(dir, 'state.json');
    const fence = file + '.lock.stale.owner.' + 'a'.repeat(24);
    const staging = join(dir, '.compacting.' + basename(fence) + '.' + 'b'.repeat(24));
    let elapsed = 0;
    const replaceEntry = (source, destination) => {
      if (${JSON.stringify(emulate)}) {
        try {
          const entry = fs.lstatSync(destination);
          if (entry.isFile() || entry.isSymbolicLink()) fs.unlinkSync(destination);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      realRename(source, destination);
    };
    let renameEntry = replaceEntry;
    mock.module(${JSON.stringify(retryModule)}, () => ({
      ...retry,
      renameWithRetry: (source, destination, options) => retryRename(source, destination, {
        ...options, platform: 'win32', now: () => elapsed, random: () => 0,
        sleep: (ms) => { elapsed += ms; },
        rename: (source, destination) => renameEntry(source, destination),
      }),
    }));
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { sweepLockQuarantine } = await import(${JSON.stringify(lockModule)});
    const strong = (path) => fs.lstatSync(path).isDirectory() && fs.readdirSync(path).length > 0;
    ${body}
    console.log('fence scenario complete');
  `,
  ]);
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain("fence scenario complete");
}

it("atomically upgrades a reserved Windows legacy file fence to a nonempty directory", () => {
  windowsFenceScenario(`
    fs.writeFileSync(fence, '');
    sweepLockQuarantine(file);
    assert(strong(fence), 'legacy file was not upgraded');
    assert(fs.existsSync(join(fence, 'tombstone')));
    const identity = fs.lstatSync(fence, { bigint: true }).ino;
    sweepLockQuarantine(file);
    assert.equal(fs.lstatSync(fence, { bigint: true }).ino, identity);
    assert(!fs.readdirSync(dir).some((name) => name.startsWith('.compacting.')));
  `);
});

it("publishes a complete guard over a reserved empty Windows quarantine directory", () => {
  windowsFenceScenario(`
    fs.mkdirSync(fence);
    sweepLockQuarantine(file);
    assert(strong(fence), 'empty directory was not upgraded');
    assert(fs.existsSync(join(fence, 'tombstone')));
  `);
});

it("recovers orphan staging directories and files before discarding them on Windows", () => {
  for (const shape of ["directory", "file"])
    windowsFenceScenario(`
    fs.writeFileSync(fence, '');
    if (${JSON.stringify(shape)} === 'directory') {
      fs.mkdirSync(staging);
      fs.writeFileSync(join(staging, 'tombstone'), 'preserved generation');
    } else fs.writeFileSync(staging, 'unfinished compaction');
    sweepLockQuarantine(file);
    assert(strong(fence));
    assert(!fs.existsSync(staging), 'orphan staging remained after successful repair');
  `);
});

it("retains orphan data and reuses a staged Windows guard when publication stays blocked", () => {
  windowsFenceScenario(`
    fs.writeFileSync(fence, 'legacy');
    fs.writeFileSync(staging, 'orphan record');
    renameEntry = (source, destination) => {
      if (destination === fence) throw Object.assign(new Error('blocked publication'), { code: 'EACCES' });
      return replaceEntry(source, destination);
    };
    sweepLockQuarantine(file);
    const afterFirst = fs.readdirSync(dir).sort();
    assert.equal(fs.readFileSync(fence, 'utf8'), 'legacy');
    assert.equal(fs.readFileSync(staging, 'utf8'), 'orphan record');
    assert(afterFirst.some((name) => name !== basename(staging) && name.startsWith('.compacting.')));
    sweepLockQuarantine(file);
    assert.deepEqual(fs.readdirSync(dir).sort(), afterFirst, 'blocked repair allocated more staging');
    assert.equal(fs.readFileSync(staging, 'utf8'), 'orphan record');
  `);
});

it("does not mistake a canonical Windows symlink for a strong fence", () => {
  windowsFenceScenario(`
    const outside = join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, 'tombstone'), 'outside data');
    fs.symlinkSync(outside, fence, 'junction');
    fs.writeFileSync(staging, 'orphan record');
    renameEntry = (source, destination) => {
      if (destination === fence) throw Object.assign(new Error('blocked symlink replacement'), { code: 'EACCES' });
      return replaceEntry(source, destination);
    };
    sweepLockQuarantine(file);
    assert(fs.lstatSync(fence).isSymbolicLink());
    assert.equal(fs.readFileSync(staging, 'utf8'), 'orphan record');
    assert.equal(fs.readFileSync(join(outside, 'tombstone'), 'utf8'), 'outside data');
    assert.deepEqual(fs.readdirSync(outside), ['tombstone']);
  `);
});

it("preserves a competing nonempty Windows directory fence and then cleans only reserved staging", () => {
  windowsFenceScenario(`
    fs.writeFileSync(fence, 'legacy');
    fs.writeFileSync(staging, 'orphan record');
    let replaced = false;
    renameEntry = (source, destination) => {
      if (destination === fence && !replaced) {
        replaced = true;
        fs.unlinkSync(fence);
        fs.mkdirSync(fence);
        fs.writeFileSync(join(fence, 'tombstone'), 'other publisher');
      }
      return replaceEntry(source, destination);
    };
    sweepLockQuarantine(file);
    assert.equal(fs.readFileSync(join(fence, 'tombstone'), 'utf8'), 'other publisher');
    assert(!fs.existsSync(staging));
    assert(!fs.readdirSync(dir).some((name) => name.startsWith('.compacting.')));
  `);
});

it("removes only its own incomplete empty staging directory when the guard marker cannot be written", () => {
  windowsFenceScenario(`
    fs.writeFileSync(fence, 'legacy');
    fs.writeFileSync(staging, 'orphan record');
    const actualFs = { ...fs };
    const realWrite = fs.writeFileSync;
    mock.module('node:fs', () => ({
      ...actualFs,
      writeFileSync: (path, ...args) => {
        if (String(path).includes('.compacting.') && String(path).endsWith('tombstone'))
          throw Object.assign(new Error('no room for marker'), { code: 'ENOSPC' });
        return realWrite(path, ...args);
      },
    }));
    for (let attempt = 0; attempt < 2; attempt++) {
      sweepLockQuarantine(file);
      assert.equal(fs.readFileSync(fence, 'utf8'), 'legacy');
      assert.equal(fs.readFileSync(staging, 'utf8'), 'orphan record');
      assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.compacting.')), [basename(staging)]);
    }
  `);
});
