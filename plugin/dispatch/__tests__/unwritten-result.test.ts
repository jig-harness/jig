/**
 * The evidence of an unwritten end: only the file of the record's own token
 * digest counts, so a file another token wrote neither counts nor keeps the
 * genuine pass's evidence out; and `jig dispatch result` keeps it only when
 * the state database itself failed, never for a code defect.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeUnwritten,
  unwrittenOf,
  writeUnwritten,
} from "../lib/unwritten-result.ts";
import { guardedResult } from "../result.ts";

const ID = "20261114T110000Z-aaaaaaaa";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-unwritten-"));
  roots.push(dir);
  return dir;
}

const files = (dir: string) =>
  existsSync(join(dir, "unwritten")) ? readdirSync(join(dir, "unwritten")) : [];

describe("the evidence of an unwritten end", () => {
  it("ignores a file another token wrote, and still keeps the genuine pass's", () => {
    const dir = root();
    expect(writeUnwritten(dir, ID, "not-the-token", "result", "refused")).toBe(
      true,
    );
    expect(unwrittenOf(dir, ID, "the-token")).toEqual({});
    expect(writeUnwritten(dir, ID, "the-token", "result", "refused")).toBe(
      true,
    );
    expect(unwrittenOf(dir, ID, "the-token")).toEqual({
      unwritten: expect.any(String),
    });
  });

  it("is removed with its record, every token's file, and a removal that fails stops nothing", () => {
    const dir = root();
    writeUnwritten(dir, ID, "the-token", "result", "refused");
    writeUnwritten(dir, ID, "not-the-token", "exit", "refused");
    removeUnwritten(dir, [ID]);
    expect(files(dir)).toEqual([]);
    const blocked = root();
    writeFileSync(join(blocked, "unwritten"), "not a directory");
    expect(() => removeUnwritten(blocked, [ID])).not.toThrow();
  });
});

describe("jig dispatch result's guard", () => {
  it("keeps the evidence and exits 4 when the state database fails the write", async () => {
    const dir = root();
    const exit = await guardedResult(
      ID,
      "the-token",
      // SQLite's own error, as a refused write raises it.
      () =>
        new Database(":memory:").query("SELECT * FROM launches").all().length,
      dir,
    );
    expect(exit).toBe(4);
    expect(unwrittenOf(dir, ID, "the-token").unwritten).toBeString();
  });

  it("reports a code defect as one: no exit 4 and no evidence", async () => {
    const dir = root();
    const run = guardedResult(
      ID,
      "the-token",
      () => {
        throw new TypeError("undefined is not an object");
      },
      dir,
    );
    await expect(run).rejects.toThrow(TypeError);
    expect(files(dir)).toEqual([]);
  });
});
