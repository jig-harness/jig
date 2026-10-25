import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  runStages,
  shardArgs,
  TEST_SHARD_ENV,
  testArgs,
  testStage,
} from "./gates.ts";

const root = join(import.meta.dir, "..");

test("a shard the environment names is the test stage's last argument", () => {
  expect(shardArgs({})).toEqual([]);
  expect(shardArgs({ [TEST_SHARD_ENV]: "" })).toEqual([]);
  expect(shardArgs({ [TEST_SHARD_ENV]: "2/4" })).toEqual(["--shard=2/4"]);
  expect(testArgs([], [], ["--shard=1/2"])).toEqual([
    "run",
    "test",
    "--shard=1/2",
  ]);
  expect(testArgs(["suite/**"], ["**/fixtures/**"], ["--shard=1/2"])).toEqual([
    "run",
    "test",
    "--path-ignore-patterns=**/fixtures/**",
    "--path-ignore-patterns=suite/**",
    "--shard=1/2",
  ]);
  expect(
    testStage(
      ["suite/**"],
      () => ["**/fixtures/**"],
      () => shardArgs({ [TEST_SHARD_ENV]: "3/4" }),
    ),
  ).toMatchObject({
    command: [
      "run",
      "test",
      "--path-ignore-patterns=**/fixtures/**",
      "--path-ignore-patterns=suite/**",
      "--shard=3/4",
    ],
  });
});

test("a malformed shard makes the test stage could not check", async () => {
  for (const bad of ["0/4", "5/4", "2", "2/4/1", "a/b", " 2/4"])
    expect(() => shardArgs({ [TEST_SHARD_ENV]: bad })).toThrow(TEST_SHARD_ENV);
  const malformed = testStage(
    [],
    () => [],
    () => shardArgs({ [TEST_SHARD_ENV]: "9/4" }),
  );
  expect(malformed).toMatchObject({ name: "bun run test" });
  const [outcome] = await runStages([malformed], root);
  expect(outcome?.status).toBe(2);
});
