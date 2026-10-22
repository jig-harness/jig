import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { hasPrefix, spelledLike } from "../scripts/scratch.ts";
import { runScript } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const workdir = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "scratch-test-")));
  dirs.push(d);
  return d;
};
const scratch = (cwd: string, ...args: string[]) => {
  const r = runScript("scratch.ts", args, cwd);
  return { ...r, result: { exitCode: r.code, stdout: r.out, stderr: r.err } };
};

describe("scratch.ts --directory", () => {
  test("makes a fresh folder under a parent inside the working directory", () => {
    const cwd = workdir();
    const r = scratch(cwd, "--directory", ".context/jig-audit");
    expectSpawnExit(r.result, 0);
    const made = r.out.trim();
    expect(dirname(made)).toBe(join(cwd, ".context", "jig-audit"));
    expect(existsSync(made)).toBe(true);
  });

  test("accepts a folder whose name only starts with two dots", () => {
    const cwd = workdir();
    const r = scratch(cwd, "--directory", "..cache");
    expectSpawnExit(r.result, 0);
    expect(dirname(r.out.trim())).toBe(join(cwd, "..cache"));
  });

  test("refuses a parent reached through a link that leaves the working directory", () => {
    const cwd = workdir();
    const outside = workdir();
    // "junction" lets Windows make a directory link without privileges.
    symlinkSync(outside, join(cwd, ".context"), "junction");
    const r = scratch(cwd, "--directory", ".context/jig-audit");
    expectSpawnExit(r.result, 2);
    expect(r.err).toContain("--directory must name a folder inside");
    expect(readdirSync(outside)).toEqual([]);
  });

  test.if(process.platform === "win32")(
    "accepts an absolute child spelled in a different case",
    () => {
      const cwd = workdir();
      const r = scratch(
        cwd,
        "--directory",
        join(cwd.toUpperCase(), ".context"),
      );
      expectSpawnExit(r.result, 0);
      expect(dirname(r.out.trim()).toLowerCase()).toBe(
        join(cwd, ".context").toLowerCase(),
      );
    },
  );

  for (const [name, arg] of [
    ["a relative path that climbs out", "../elsewhere"],
    ["an absolute path outside", join(tmpdir(), "scratch-test-outside")],
    ["the working directory itself", "."],
  ] as const) {
    test(`refuses ${name}`, () => {
      const cwd = workdir();
      const r = scratch(cwd, "--directory", arg);
      expectSpawnExit(r.result, 2);
      expect(r.err).toContain("--directory must name a folder inside");
      expect(r.out).toBe("");
    });
  }
});

describe("hasPrefix", () => {
  test("ignores case on Windows, as path.relative does there", () => {
    expect(hasPrefix("C:\\Work\\Repo\\x", "c:\\work\\repo\\", "win32")).toBe(
      true,
    );
  });

  test("keeps case elsewhere", () => {
    expect(hasPrefix("/Work/Repo/x", "/work/repo/", "linux")).toBe(false);
    expect(hasPrefix("/Work/Repo/x", "/work/repo/", "darwin")).toBe(false);
    expect(hasPrefix("/Work/Repo/x", "/Work/Repo/", "darwin")).toBe(true);
  });
});

describe("spelledLike", () => {
  test("adopts the root's spelling of a case-variant prefix on Windows", () => {
    expect(spelledLike("C:\\Work\\", "c:\\WORK\\sub", "win32")).toBe(
      "C:\\Work\\sub",
    );
  });

  test("never respells by an offset a length-changing case map shifted", () => {
    // "İ" lower-cases to "i̇", two code units: a root spelled "i̇" folds equal
    // to a path spelled "İ" whose prefix is one unit shorter, and slicing the
    // path at the root's length would drop a character of the child's name.
    expect(spelledLike("C:\\i\u0307\\", "C:\\İ\\sub", "win32")).toBe(
      "C:\\İ\\sub",
    );
  });

  test("leaves a path outside the root, or any path elsewhere, unchanged", () => {
    expect(spelledLike("C:\\Work\\", "D:\\Other", "win32")).toBe("D:\\Other");
    expect(spelledLike("/Work/", "/work/sub", "linux")).toBe("/work/sub");
  });
});
