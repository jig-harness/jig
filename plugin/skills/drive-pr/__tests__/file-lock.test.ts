import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
    expect(readdirSync(root).filter((n) => n.startsWith("plain."))).toEqual([]);
  });

  it("breaks a stale guard of the lock's own generation, then releases normally", async () => {
    const file = join(root, "dead-guard");
    const lock = fileLock(file, "test");
    await lock.acquire();
    const token = JSON.parse(readFileSync(`${file}.lock`, "utf8")).token;
    const guard = `${file}.lock.unlink.${token}`;
    writeFileSync(guard, "someone-else");
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(guard, old, old);
    lock.release();
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(existsSync(guard)).toBe(false);
  });

  it("is not blocked by a stale guard of another generation, and sweeps it", async () => {
    const file = join(root, "other-generation");
    const orphan = `${file}.lock.unlink.someone-elses`;
    const fresh = `${file}.lock.unlink.in-progress`;
    writeFileSync(orphan, "x");
    writeFileSync(fresh, "x");
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(orphan, old, old);
    const lock = fileLock(file, "test");
    await lock.acquire();
    lock.release();
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("does not remove a fresh guard it does not own", async () => {
    const file = join(root, "fresh-guard");
    const lock = fileLock(file, "test");
    await lock.acquire();
    const token = JSON.parse(readFileSync(`${file}.lock`, "utf8")).token;
    const guard = `${file}.lock.unlink.${token}`;
    writeFileSync(guard, "someone-else");
    lock.release();
    expect(existsSync(guard)).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(true);
  });
});
