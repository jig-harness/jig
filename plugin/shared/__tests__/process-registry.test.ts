import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createProcessRegistry,
  processRegistryRoots,
} from "../process-registry.ts";

test("each pass has an isolated registry and an empty registry is readable", () => {
  const first = createProcessRegistry();
  const second = createProcessRegistry();
  try {
    expect(first.dir).not.toBe(second.dir);
    expect(processRegistryRoots(first.dir)).toEqual([]);
    writeFileSync(
      join(first.dir, "runner.json"),
      JSON.stringify({ pid: 123, start: "created" }),
    );
    expect(processRegistryRoots(first.dir)).toEqual([
      { pid: 123, start: "created" },
    ]);
    expect(processRegistryRoots(second.dir)).toEqual([]);
  } finally {
    first.dispose();
    second.dispose();
  }
  expect(processRegistryRoots(first.dir)).toBeNull();
});

for (const [name, value] of [
  ["runner.pending", ""],
  ["malformed.json", "{"],
  ["missing-start.json", '{"pid":123}'],
] as const) {
  test(`${name} withholds the termination witness`, () => {
    const registry = createProcessRegistry();
    try {
      writeFileSync(join(registry.dir, name), value);
      expect(processRegistryRoots(registry.dir)).toBeNull();
    } finally {
      registry.dispose();
    }
  });
}
