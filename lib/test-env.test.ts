import { expect, test } from "bun:test";
import { normalizePathKey } from "./test-env.ts";

test("a Windows-spelled Path becomes PATH", () => {
  const env: Record<string, string | undefined> = { Path: "C:\\bin", A: "1" };
  normalizePathKey(env);
  expect(env).toEqual({ PATH: "C:\\bin", A: "1" });
});

test("an environment that already says PATH is left as it is", () => {
  const env: Record<string, string | undefined> = { PATH: "/bin", B: "2" };
  normalizePathKey(env);
  expect(env).toEqual({ PATH: "/bin", B: "2" });
});

test("when both spellings are present the explicit PATH wins and Path goes", () => {
  const env: Record<string, string | undefined> = { Path: "old", PATH: "new" };
  normalizePathKey(env);
  expect(env).toEqual({ PATH: "new" });
});

test("an environment without a path is left without one", () => {
  const env: Record<string, string | undefined> = { C: "3" };
  normalizePathKey(env);
  expect(env).toEqual({ C: "3" });
});

test("the preload leaves a spread of the test environment with one path key", () => {
  const keys = Object.keys({ ...process.env }).filter(
    (key) => key.toLowerCase() === "path",
  );
  expect(keys).toEqual(["PATH"]);
});
