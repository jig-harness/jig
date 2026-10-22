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
import { foldCase } from "../scripts/scratch.ts";
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

describe("foldCase", () => {
  test("ignores case on Windows, as path.relative does there", () => {
    expect(foldCase("C:\\Work\\Repo", "win32")).toBe("c:\\work\\repo");
  });

  test("keeps case elsewhere", () => {
    expect(foldCase("/Work/Repo", "linux")).toBe("/Work/Repo");
    expect(foldCase("/Work/Repo", "darwin")).toBe("/Work/Repo");
  });
});
