import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLock } from "../scripts/lib/state/file-lock.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "file-lock-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("fileLock's removal guard", () => {
  it("leaves nothing behind after an ordinary acquire and release", async () => {
    const file = join(root, "plain");
    const lock = fileLock(file, "test");
    await lock.acquire();
    lock.release();
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(existsSync(`${file}.lock.unlink`)).toBe(false);
  });

  it("breaks a guard left by a dead removal, then releases normally", async () => {
    const file = join(root, "dead-guard");
    const guard = `${file}.lock.unlink`;
    writeFileSync(guard, "someone-else");
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(guard, old, old);
    const lock = fileLock(file, "test");
    await lock.acquire();
    lock.release();
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(existsSync(guard)).toBe(false);
  });

  it("does not remove a fresh guard it does not own", async () => {
    const file = join(root, "fresh-guard");
    const guard = `${file}.lock.unlink`;
    const lock = fileLock(file, "test");
    await lock.acquire();
    writeFileSync(guard, "someone-else");
    lock.release();
    expect(existsSync(guard)).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(true);
  });
});
