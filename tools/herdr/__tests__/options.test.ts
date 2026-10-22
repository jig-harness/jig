import { expect, test } from "bun:test";
import { parseOpen } from "../options.ts";

const open = (...more: string[]) =>
  parseOpen(["--repo", "/repo", "--branch", "feature/ENG-1-fix", ...more]);

test("a reuse prefix must be non-empty and start the branch", () => {
  expect(open("--reuse-prefix", "feature/ENG-1-").reusePrefix).toBe(
    "feature/ENG-1-",
  );
  expect(open().reusePrefix).toBeUndefined();
  expect(() => open("--reuse-prefix", "")).toThrow("must be non-empty");
  expect(() => open("--reuse-prefix", "feature/ENG-2-")).toThrow(
    "start --branch",
  );
});
