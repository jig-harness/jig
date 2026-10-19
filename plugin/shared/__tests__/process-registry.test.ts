import { captureRegisteredProcessTrees } from "../process-tree.ts";
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createProcessRegistry,
  beginProcessRegistration,
  handoffProcessRegistration,
  processRegistryRoots,
  processRegistrySnapshot,
  processIdentityCompleted,
  processIdentityUnwitnessed,
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

test("an empty registry can be read without a native process-table query", async () => {
  const registry = createProcessRegistry();
  try {
    let queries = 0;
    expect(
      await captureRegisteredProcessTrees(registry.dir, async () => {
        queries++;
        return null;
      }),
    ).toEqual([]);
    expect(queries).toBe(0);
  } finally {
    registry.dispose();
  }
});

test("nested command scopes see their own descendants, while acquisition sees every scope", () => {
  const acquisition = createProcessRegistry();
  const command = createProcessRegistry(acquisition.dir);
  const nested = createProcessRegistry(command.dir);
  const sibling = createProcessRegistry(acquisition.dir);
  try {
    writeFileSync(
      join(acquisition.dir, "parent.json"),
      JSON.stringify({ pid: 1, start: "parent" }),
    );
    writeFileSync(
      join(command.dir, "command.json"),
      JSON.stringify({ pid: 2, start: "command" }),
    );
    writeFileSync(
      join(nested.dir, "nested.json"),
      JSON.stringify({ pid: 3, start: "nested" }),
    );
    writeFileSync(
      join(sibling.dir, "sibling.json"),
      JSON.stringify({ pid: 4, start: "sibling" }),
    );
    expect(
      processRegistryRoots(command.dir)
        ?.map((r) => r.pid)
        .sort(),
    ).toEqual([2, 3]);
    expect(
      processRegistryRoots(acquisition.dir)
        ?.map((r) => r.pid)
        .sort(),
    ).toEqual([1, 2, 3, 4]);
    expect(processRegistryRoots(sibling.dir)?.map((r) => r.pid)).toEqual([4]);
  } finally {
    acquisition.dispose();
    command.dispose();
    nested.dispose();
    sibling.dispose();
  }
});

test("completed pending records are reconciled, but malformed completion cannot clear ownership uncertainty", () => {
  const registry = createProcessRegistry();
  const resultFile = join(registry.dir, "result.tmp");
  try {
    beginProcessRegistration(registry.dir, "runner", resultFile);
    expect(processRegistryRoots(registry.dir)).toBeNull();
    writeFileSync(resultFile, '{"exitCode":"0"}');
    expect(processRegistryRoots(registry.dir)).toBeNull();
    writeFileSync(resultFile, '{"exitCode":0,"signal":null}');
    expect(processRegistryRoots(registry.dir)).toBeNull();
    writeFileSync(
      resultFile,
      '{"exitCode":0,"treeWitnessed":false,"note":"descendants may survive"}',
    );
    expect(processRegistryRoots(registry.dir)).toBeNull();
    writeFileSync(
      resultFile,
      '{"exitCode":0,"signal":null,"treeWitnessed":true}',
    );
    expect(processRegistryRoots(registry.dir)).toEqual([]);
  } finally {
    registry.dispose();
  }
});

test("a transient failed handoff retries and records only pid plus creation identity", async () => {
  const registry = createProcessRegistry();
  try {
    beginProcessRegistration(
      registry.dir,
      "runner",
      join(registry.dir, "result.tmp"),
    );
    let probes = 0;
    expect(
      await handoffProcessRegistration(
        registry.dir,
        "runner",
        123,
        () => false,
        () => true,
        {
          table: async () =>
            ++probes === 1
              ? null
              : [
                  {
                    pid: 123,
                    ppid: 1,
                    pgid: 0,
                    start: "created",
                    stat: "R",
                    args: "private prompt",
                  },
                ],
          timeoutMs: 1000,
          pollMs: 1,
        },
      ),
    ).toBe(true);
    expect(probes).toBe(2);
    expect(processRegistryRoots(registry.dir)).toEqual([
      {
        pid: 123,
        start: "created",
        resultFile: join(registry.dir, "result.tmp"),
      },
    ]);
    expect(
      readFileSync(join(registry.dir, "runner.json"), "utf8"),
    ).not.toContain("private prompt");
  } finally {
    registry.dispose();
  }
});

test("an unresolved handoff is bounded and a later result reconciles its marker", async () => {
  const registry = createProcessRegistry();
  const resultFile = join(registry.dir, "result.tmp");
  try {
    beginProcessRegistration(registry.dir, "runner", resultFile);
    expect(
      await handoffProcessRegistration(
        registry.dir,
        "runner",
        123,
        () => false,
        () => true,
        { table: async () => null, timeoutMs: 5, pollMs: 1 },
      ),
    ).toBe(false);
    expect(processRegistryRoots(registry.dir)).toBeNull();
    writeFileSync(resultFile, '{"exitCode":0,"treeWitnessed":true}');
    expect(processRegistryRoots(registry.dir)).toEqual([]);
  } finally {
    registry.dispose();
  }
});

test("a pid owner lost during enumeration never becomes a registered stranger", async () => {
  const registry = createProcessRegistry();
  let owned = true;
  try {
    beginProcessRegistration(
      registry.dir,
      "runner",
      join(registry.dir, "result.tmp"),
    );
    expect(
      await handoffProcessRegistration(
        registry.dir,
        "runner",
        123,
        () => false,
        () => owned,
        {
          table: async () => {
            owned = false;
            return [
              {
                pid: 123,
                ppid: 1,
                pgid: 0,
                start: "stranger",
                stat: "R",
                args: "",
              },
            ];
          },
          timeoutMs: 5,
          pollMs: 1,
        },
      ),
    ).toBe(false);
    expect(processRegistryRoots(registry.dir)).toBeNull();
  } finally {
    registry.dispose();
  }
});

test("unresolved registration withholds completion while preserving independently verified roots", () => {
  const registry = createProcessRegistry();
  try {
    writeFileSync(
      join(registry.dir, "known.json"),
      JSON.stringify({ pid: 123, start: "known" }),
    );
    beginProcessRegistration(
      registry.dir,
      "pending",
      join(registry.dir, "missing-result.tmp"),
    );
    expect(processRegistryRoots(registry.dir)).toBeNull();
    expect(processRegistrySnapshot(registry.dir)).toEqual({
      roots: [{ pid: 123, start: "known" }],
      complete: false,
    });
  } finally {
    registry.dispose();
  }
});

test("identity records retain completion authority when no terminal result could be written", () => {
  const registry = createProcessRegistry();
  const resultFile = join(registry.dir, "result.tmp");
  try {
    const identity = { pid: 123, start: "created", resultFile };
    writeFileSync(join(registry.dir, "runner.json"), JSON.stringify(identity));
    expect(processRegistrySnapshot(registry.dir).roots).toEqual([identity]);
    expect(processIdentityCompleted(identity)).toBe(false);
    writeFileSync(
      resultFile,
      '{"exitCode":0,"treeWitnessed":false,"note":"descendants may survive"}',
    );
    expect(processIdentityCompleted(identity)).toBe(false);
    expect(processRegistrySnapshot(registry.dir).roots).toEqual([identity]);
    writeFileSync(resultFile, '{"exitCode":0,"treeWitnessed":true}');
    expect(processIdentityCompleted(identity)).toBe(true);
    expect(processRegistryRoots(registry.dir)).toEqual([]);
  } finally {
    registry.dispose();
  }
});

test("explicit unwitnessed completion differs from missing or malformed completion", () => {
  const registry = createProcessRegistry();
  const resultFile = join(registry.dir, "result.tmp");
  const identity = { pid: 123, start: "created", resultFile };
  try {
    expect(processIdentityUnwitnessed(identity)).toBe(false);
    writeFileSync(resultFile, '{"exitCode":"0","treeWitnessed":false}');
    expect(processIdentityUnwitnessed(identity)).toBe(false);
    writeFileSync(resultFile, '{"exitCode":0,"treeWitnessed":false}');
    expect(processIdentityUnwitnessed(identity)).toBe(true);
    expect(processIdentityCompleted(identity)).toBe(false);
    writeFileSync(resultFile, '{"exitCode":0,"treeWitnessed":true}');
    expect(processIdentityUnwitnessed(identity)).toBe(false);
    expect(processIdentityCompleted(identity)).toBe(true);
  } finally {
    registry.dispose();
  }
});
