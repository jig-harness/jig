/**
 * A working directory is marked disposable where it is written: the tag file
 * starts with the cache directory tagging signature, an existing tag is left
 * alone, and a failure to tag is a value the caller may ignore.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHEDIR_TAG,
  CACHEDIR_TAG_SIGNATURE,
  markDisposable,
} from "../disposable-mark.ts";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "disposable-mark-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("markDisposable", () => {
  it("creates the directory and a tag that starts with the signature", () => {
    const dir = join(root(), ".context", "drive-mailbox");
    expect(markDisposable(dir)).toEqual({ ok: true, value: undefined });
    expect(
      readFileSync(join(dir, CACHEDIR_TAG), "utf8").startsWith(
        CACHEDIR_TAG_SIGNATURE,
      ),
    ).toBe(true);
  });

  it("leaves an existing tag untouched", () => {
    const dir = root();
    const tag = join(dir, CACHEDIR_TAG);
    const existing = `${CACHEDIR_TAG_SIGNATURE}\n# written by another tool\n`;
    writeFileSync(tag, existing);
    expect(markDisposable(dir).ok).toBe(true);
    expect(markDisposable(dir).ok).toBe(true);
    expect(readFileSync(tag, "utf8")).toBe(existing);
  });

  it("returns a failure, not a throw, when the directory cannot be made", () => {
    const parent = join(root(), "a-file");
    writeFileSync(parent, "");
    const outcome = markDisposable(join(parent, "below"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("unmarked");
    expect(outcome.failure.reason).toContain(join(parent, "below"));
  });
});
