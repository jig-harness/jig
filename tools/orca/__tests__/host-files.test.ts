/**
 * What the Orca workspace tool reads and writes in a worktree's git
 * directory on the host: what is at a path, read from the reason the host
 * gives and nowhere else in its message, and the worktree's token, published
 * for exactly one open and read back.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectSpawnExit,
  expectSpawnExitNot,
} from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { type Answer, fail, ok } from "../../herdr/__tests__/fake.ts";
import { failureReason, inspectPath } from "../hooks.ts";
import { PUBLISH_TOKEN_SCRIPT, worktreeToken } from "../worktree-token.ts";
import {
  absent,
  GIT_DIR,
  inspect,
  isDir,
  isFile,
  publishToken,
  readToken,
  TOKEN,
  workspaceOf,
} from "./table.ts";

/** A journal whose path holds the words a listing fails with when nothing is there. */
const P = "/ws/app/.context/No such file or directory/journal.jsonl";
const kindOf = (answer: Answer) =>
  inspectPath(workspaceOf({ [inspect(P)]: answer }), P);

describe("what is at a path on the host", () => {
  test("is absent only when the host's reason is that nothing is there, in GNU and BSD wording", () => {
    expect(
      kindOf(fail(2, `ls: cannot access '${P}': No such file or directory\n`)),
    ).toBe("absent");
    expect(kindOf(fail(1, `ls: ${P}: No such file or directory\n`))).toBe(
      "absent",
    );
    expect(kindOf(fail(2, `ls: cannot access '${P}': Not a directory\n`))).toBe(
      "absent",
    );
  });

  test("is not absent when those words are in the path and the reason is another", () => {
    // A parent that cannot be searched, under a path named for the reason:
    // read as absent, a removal would delete findings it never saw.
    expect(() =>
      kindOf(fail(2, `ls: cannot access '${P}': Permission denied\n`)),
    ).toThrow(`cannot tell what is at ${P}`);
    expect(() => kindOf(fail(1, `ls: ${P}: Permission denied\n`))).toThrow(
      `cannot tell what is at ${P}`,
    );
    expect(() =>
      kindOf(fail(2, "ls: cannot access 'No such file or directory'\n")),
    ).toThrow("cannot tell what is at");
  });

  test("reads the kind from the listing, and a failure with no reason as one it cannot tell", () => {
    expect(kindOf(isFile)).toBe("file");
    expect(kindOf(isDir)).toBe("directory");
    expect(kindOf(ok("lrwxr-xr-x  1 me  staff  5 Jan  1 00:00 x\n"))).toBe(
      "other",
    );
    expect(() => kindOf(fail(2, "ls: terminated\n"))).toThrow(
      "cannot tell what is at",
    );
    expect(() => kindOf(fail(2, ""))).toThrow("cannot tell what is at");
  });

  test("the reason is the last line's text after its last ': ', whatever the path holds", () => {
    expect(
      failureReason(
        "mkdir: cannot create directory '/a: File exists/b': File exists\n",
      ),
    ).toBe("File exists");
    expect(failureReason("mkdir: /a/b: File exists\n")).toBe("File exists");
    expect(
      failureReason(
        "ls: cannot access '/x/No such file or directory': Permission denied\n",
      ),
    ).toBe("Permission denied");
    expect(failureReason("warning: first\nls: x: Not a directory\n\n")).toBe(
      "Not a directory",
    );
    expect(failureReason("terminated\n")).toBeNull();
    expect(failureReason("")).toBeNull();
  });
});

describe("the worktree's token", () => {
  test("is published by the open that finds none, then read from the file", () => {
    const ws = workspaceOf({
      [inspect(TOKEN)]: absent,
      [publishToken]: ok(),
      [readToken]: ok("abc123\n"),
    });
    expect(worktreeToken(ws, GIT_DIR)).toBe("abc123");
    expect(ws.ctx.calls).toEqual([inspect(TOKEN), publishToken, readToken]);
  });

  test("is read where it is when the git directory holds one", () => {
    const ws = workspaceOf({
      [inspect(TOKEN)]: isFile,
      [readToken]: ok("abc123\n"),
    });
    expect(worktreeToken(ws, GIT_DIR)).toBe("abc123");
    expect(ws.ctx.calls).toEqual([inspect(TOKEN), readToken]);
  });

  test("is the one another open published first, whatever this open minted", () => {
    const ws = workspaceOf({
      [inspect(TOKEN)]: absent,
      [publishToken]: fail(
        1,
        `ln: failed to create hard link '${TOKEN}': File exists\n`,
      ),
      [readToken]: ok("theirs\n"),
    });
    expect(worktreeToken(ws, GIT_DIR)).toBe("theirs");
  });

  test("refuses when the file cannot be read, naming the write that failed", () => {
    const ws = workspaceOf({
      [inspect(TOKEN)]: absent,
      [publishToken]: fail(1, "sh: /dev/urandom: No such file or directory\n"),
      [readToken]: fail(1, `cat: ${TOKEN}: No such file or directory\n`),
    });
    expect(() => worktreeToken(ws, GIT_DIR)).toThrow(
      /cannot read the worktree's token .*; writing it: [\s\S]*urandom/,
    );
  });

  test("refuses a directory at its name, and a file that does not hold one token", () => {
    expect(() =>
      worktreeToken(workspaceOf({ [inspect(TOKEN)]: isDir }), GIT_DIR),
    ).toThrow("not the worktree's token file");
    for (const held of ["a b\n", "\n", ""])
      expect(() =>
        worktreeToken(
          workspaceOf({ [inspect(TOKEN)]: isFile, [readToken]: ok(held) }),
          GIT_DIR,
        ),
      ).toThrow("does not hold a token this tool wrote");
  });

  test("the publishing script links a fresh token into place for the first writer only, and cleans up after itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-token-"));
    try {
      const file = join(dir, "jig-orca-worktree");
      const publish = () =>
        Bun.spawnSync(["sh", "-c", PUBLISH_TOKEN_SCRIPT, "sh", file]);
      expectSpawnExit(publish(), 0, "the first publish");
      const token = readFileSync(file, "utf8");
      expect(token).toMatch(/^[0-9a-f]{32}\n$/);
      expectSpawnExitNot(publish(), 0, "a second publish");
      expect(readFileSync(file, "utf8")).toBe(token);
      expect(readdirSync(dir)).toEqual(["jig-orca-worktree"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
