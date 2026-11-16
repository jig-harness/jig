/**
 * Path globs over repository-relative paths: compilation, matching, the
 * check whether a glob can match under a directory, and why a glob does not
 * compile.
 */
import { describe, expect, it } from "bun:test";
import { globMatchesUnder, globProblem, globToRegExp } from "../glob.ts";

describe("globToRegExp", () => {
  const cases: [string, string, boolean][] = [
    ["src/**", "src/a/b/c.ts", true],
    ["src/**/x.ts", "src/x.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["**/*.md", ".github/README.md", true],
    ["**/schema.json", "schema.json", true],
    ["**/schema.json", "a/b/schema.json", true],
    ["docs/*.md", "docs/index.md", true],
    ["docs/*.md", "docs/guide/index.md", false],
    ["file?.txt", "file1.txt", true],
    ["file?.txt", "file/.txt", false],
    ["a/{b,c}/*.ts", "a/c/d.ts", true],
    ["a/{b,c}/*.ts", "a/e/d.ts", false],
    ["a/[xy].ts", "a/y.ts", true],
    ["a/[!xy].ts", "a/y.ts", false],
    ["a/[!xy].ts", "a/z.ts", true],
    ["gen/a[!x]b.ts", "gen/a/b.ts", false],
    ["gen/a[/x]b.ts", "gen/a/b.ts", false],
    ["gen/a[/x]b.ts", "gen/axb.ts", true],
    ["gen/a[^x]b.ts", "gen/a/b.ts", false],
    ["a[]]b", "a]b", true],
    ["a[]]b", "a]]b", false],
    ["a[]x]b", "axb", true],
    ["a[!]]b", "a]b", false],
    ["a[!]]b", "acb", true],
    ["a[!]]b", "a/b", false],
    ["a[!]", "a[!]", true],
    ["gen/a[^]]b.ts", "gen/axb.ts", true],
    ["gen/a[^]]b.ts", "gen/a]b.ts", false],
    ["gen/a[^]]b.ts", "gen/a/b.ts", false],
    ["a[^xy]b", "ayb", false],
    ["a[^xy]b", "azb", true],
    ["a[x^]b", "a^b", true],
    ["a[x^]b", "azb", false],
    ["a[\\x]b", "a\\b", true],
    ["gen/**", "gen/a\nb.ts", true],
    ["**/x.ts", "a\nb/x.ts", true],
    ["a.b", "aXb", false],
    ["a(b)+c", "a(b)+c", true],
    ["a]b", "a]b", true],
    ["a[b", "a[b", true],
    ["a}b,c", "a}b,c", true],
  ];
  for (const [glob, path, matches] of cases)
    it(`${glob} ${matches ? "matches" : "does not match"} ${path}`, () => {
      expect(globToRegExp(glob).test(path)).toBe(matches);
    });
});

describe("globMatchesUnder", () => {
  it("is true when the glob matches some file under the directory", () => {
    for (const glob of [
      "**",
      "apps/**",
      "apps/web/**",
      "apps/*/**",
      "apps/*/src/**",
      "**/*.ts",
      "apps/w**",
      "{lib,apps/web}/**",
      "apps/[a-z]eb/x",
    ])
      expect([glob, globMatchesUnder(glob, "apps/web")]).toEqual([glob, true]);
  });

  it("is false when no file under the directory matches", () => {
    for (const glob of [
      "other/**",
      "apps/*",
      "apps/web",
      "apps/web/",
      "apps/web//x",
      "apps/web/[/]",
      "apps/[!w]eb/**",
      "apps/{web,api}",
      "{lib,apps/other}/**",
      // An embedded `**` spans directories but keeps its literals.
      "apps/other**/src/**",
    ])
      expect([glob, globMatchesUnder(glob, "apps/web")]).toEqual([glob, false]);
  });

  it("reads a directory name outside the Basic Multilingual Plane as matching does", () => {
    expect(globToRegExp("apps/😀/**").test("apps/😀/main.ts")).toBe(true);
    for (const glob of ["apps/😀/**", "apps/**", "apps/*/**", "**/*.ts"])
      expect([glob, globMatchesUnder(glob, "apps/😀")]).toEqual([glob, true]);
    expect(globMatchesUnder("apps/😁/**", "apps/😀")).toBe(false);
  });

  it("accepts only plain names git lists everywhere: no dotfile, `.git` form, trailing dot, device name or other character", () => {
    for (const glob of [
      "apps/web/../other/**",
      "apps/web/./x",
      "apps/web/.",
      "apps/web/..",
      "apps/web/[.]",
      "apps/web/[.][.]/x",
      "apps/web/\0",
      "apps/web/[\0]",
      // Every form of `.git` git refuses to index, in any case.
      "apps/web/.git/**",
      "apps/web/.GIT/x",
      "apps/web/.GiT/**",
      "apps/web/[.]git/x",
      "apps/web/.git./x",
      "apps/web/git~1/x",
      "apps/web/GIT~1/**",
      // A dotfile is not a plain name, so it does not cover the directory.
      "apps/web/.*",
      "apps/web/...",
      "apps/web/[.]x",
      // A class that matches only NUL, its negated range ending at the last
      // UTF-16 code unit.
      "apps/web/[!\x01-\uffff]",
      "apps/web/[\uffff]",
      "apps/web/~",
      // Git for Windows refuses a trailing `.` and a device name, in any
      // case and with any extension.
      "apps/web/x.",
      "apps/web/x./y",
      "apps/web/a.b.",
      "apps/web/CON",
      "apps/web/con.txt",
      "apps/web/Aux/**",
      "apps/web/nul.a.b",
      "apps/web/PRN",
      "apps/web/COM1",
      "apps/web/lpt9.log",
      "apps/web/LPT0",
      "apps/web/lpt0.txt",
      "apps/web/Lpt0/**",
      "apps/web/[cC]on",
      "apps/web/{CON,AUX}.ts",
      "apps/web/CON/**",
    ])
      expect([glob, globMatchesUnder(glob, "apps/web")]).toEqual([glob, false]);
    for (const glob of [
      "apps/web/?",
      "apps/web/*.ts",
      "apps/web/a.b.c",
      "apps/web/[!.]*",
      "apps/web/x..y",
      // A device name only as a prefix, a suffix or a later part is plain.
      "apps/web/CONS",
      "apps/web/co",
      "apps/web/COM",
      "apps/web/com10",
      // Git for Windows reserves COM1 to COM9 only, but LPT0 to LPT9.
      "apps/web/COM0",
      "apps/web/COM0.txt",
      "apps/web/com0/**",
      "apps/web/x.con",
      "apps/web/CON*",
      "apps/web/{CON,x}",
      "apps/web/[cC]on?",
      "apps/web/_/-",
      "apps/web/x.git/**",
    ])
      expect([glob, globMatchesUnder(glob, "apps/web")]).toEqual([glob, true]);
  });

  it("reads a brace inside a character class as a member, as matching does", () => {
    expect(globToRegExp("apps/[{}]/**").test("apps/{/a")).toBe(true);
    expect(globMatchesUnder("apps/[{}]/**", "apps/{")).toBe(true);
  });

  it("takes time in proportion to the glob, not to its brace expansion", () => {
    const glob = `apps/${"{a,b}".repeat(30)}/**`;
    const started = performance.now();
    expect(globMatchesUnder(glob, "apps/web")).toBe(false);
    expect(globMatchesUnder(glob, `apps/${"ab".repeat(15)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("globProblem", () => {
  it("says why a glob cannot compile, and nothing for one that can", () => {
    expect(globProblem("src/{a,b}/**")).toBeNull();
    expect(globProblem("src/{a,b")).toContain("unclosed {");
    expect(globProblem("[z-a]")).toContain('"[z-a]" is not a valid glob');
  });
});
