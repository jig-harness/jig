/** Reading the directory a `claude plugin update --json` result names. */
import { expect, test } from "bun:test";
import { updatedProject } from "../scoped-installs.ts";

const result = (message: unknown) =>
  JSON.stringify({ command: "update", outcome: "ok", message });

test("the directory an update result names, from its message", () => {
  expect(
    updatedProject(
      `${result("updated from 0.292.0 to 0.293.0 for scope project (/work/repo pickup)")}\n`,
    ),
  ).toBe("/work/repo pickup");
  expect(
    updatedProject(
      result("updated from 0.1.0 to 0.2.0 for scope local (/work/repo)."),
    ),
  ).toBe("/work/repo");
});

test("a result that names no directory, or is not JSON, names none", () => {
  expect(
    updatedProject(result("jig is already at the latest version (0.300.0).")),
  ).toBeNull();
  expect(updatedProject(result(42))).toBeNull();
  expect(updatedProject("Updated jig.\n")).toBeNull();
  expect(updatedProject("")).toBeNull();
});
