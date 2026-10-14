import { expect, test } from "bun:test";
import {
  formatFinding,
  githubAnnotation,
  location,
  repoPath,
} from "./findings.ts";

test("a finding prints its place, rule, problem and fix", () => {
  const finding = {
    rule: "no-bare-todo",
    file: "src/app.ts",
    line: 4,
    problem: "TODO without an issue",
    remedy: "cite the issue",
  };
  expect(formatFinding(finding)).toBe(
    "src/app.ts:4: [no-bare-todo] TODO without an issue\n  fix: cite the issue",
  );
  const { line: _line, ...noLine } = finding;
  expect(location(noLine)).toBe("src/app.ts");
  const { file: _file, ...noFile } = finding;
  expect(location(noFile)).toBe("(repository)");
});

test("an annotation escapes its properties and its message", () => {
  expect(
    githubAnnotation({
      rule: "rule: a, b",
      file: "dir,1/a:b%.md",
      line: 2,
      problem: "50% done\r\nnext",
      remedy: "x",
    }),
  ).toBe(
    "::error file=dir%2C1/a%3Ab%25.md,line=2,title=rule%3A a%2C b::50%25 done%0D%0Anext Fix: x",
  );
});

test("an annotation without a file carries no file or line", () => {
  expect(
    githubAnnotation({ rule: "r", line: 3, problem: "p", remedy: "f" }),
  ).toBe("::error title=r::p Fix: f");
});

test("a finding's path is relative to the root, with forward slashes", () => {
  expect(repoPath("/repo", "/repo/docs/a.md")).toBe("docs/a.md");
});
