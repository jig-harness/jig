import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableSummary } from "../lib/pass-output.ts";
import {
  eraseStewardOutput,
  keepStewardRun,
  readStewardDigest,
  type StewardDigest,
} from "../lib/steward.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";

describe("durable output summary", () => {
  test("redacts credential-shaped values and bounds the length", () => {
    const text =
      `x`.repeat(5000) +
      "\nAuthorization: Bearer abcdefgh12345678\nGITHUB_TOKEN=ghp_abcdefghijkl1234\nmail me@example.com";
    const kept = durableSummary(text);
    expect(kept.length).toBeLessThanOrEqual(2000);
    expect(kept).not.toContain("abcdefgh12345678");
    expect(kept).not.toContain("ghp_abcdefghijkl1234");
    expect(kept).not.toContain("me@example.com");
  });

  test("redacts quoted JSON credentials and a question's email and password", () => {
    const json = durableSummary(
      '{"password":"hunter2","api_key":"abcdefgh12345678","ok":"keep"}',
    );
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("abcdefgh12345678");
    expect(json).toContain("keep");
    const asked = durableSummary(
      "Should I contact me@example.com using password=hunter2?",
    );
    expect(asked).not.toContain("me@example.com");
    expect(asked).not.toContain("hunter2");
  });
});

describe("quoted values after an unquoted key", () => {
  test("redacts the whole double-quoted, single-quoted and YAML value", () => {
    for (const text of [
      'password="correct horse battery staple" rest',
      "password='correct horse battery staple' rest",
      'password: "correct horse battery staple" rest',
    ]) {
      const kept = durableSummary(text);
      expect(kept).not.toContain("horse");
      expect(kept).not.toContain("staple");
      expect(kept).toContain("rest");
    }
  });

  test("redacts a value holding an escaped quote, for both key forms", () => {
    for (const text of [
      "password: 'correct ''horse battery'' staple' rest",
      "\"password\": 'correct ''horse battery'' staple' rest",
      'password="correct ""horse battery"" staple" rest',
      'password: "correct \\"horse battery\\" staple" rest',
    ]) {
      const kept = durableSummary(text);
      expect(kept).not.toContain("horse");
      expect(kept).not.toContain("staple");
      expect(kept).toContain("rest");
    }
  });
});

describe("steward output erasure", () => {
  const roots: string[] = [];
  afterAll(() => {
    closeStateDb();
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  test("erases output fields of digests past the retention only", () => {
    const root = mkdtempSync(join(tmpdir(), "steward-erase-"));
    roots.push(root);
    const digest = (): StewardDigest =>
      ({
        version: 1,
        repo: "o/r",
        drives: [],
        needs: [],
        queue: [],
        passes: [
          {
            record: "p",
            action: "pickup",
            target: "t",
            question: "q?",
            said: "context",
          },
        ],
        failures: [],
        targets: [
          {
            target: "t",
            lastPass: {
              record: "p",
              output: { untrusted: true, tail: "secret-ish", truncated: false },
            },
          },
        ],
      }) as unknown as StewardDigest;
    const day = 86_400_000;
    keepStewardRun("old", digest(), 0, root);
    keepStewardRun("new", digest(), 40 * day, root);
    expect(eraseStewardOutput(41 * day, 30, root)).toBe(1);
    const old = readStewardDigest("old", root);
    const fresh = readStewardDigest("new", root);
    if (!old.ok || !fresh.ok) throw new Error("digests did not read");
    expect(old.value.passes[0]?.said).toBeNull();
    expect(old.value.passes[0]?.question).toBeNull();
    expect(eraseStewardOutput(41 * day, 30, root)).toBe(0);
    expect(JSON.stringify(old.value)).not.toContain("secret-ish");
    expect(JSON.stringify(fresh.value)).toContain("secret-ish");
  });

  test("an expired unreadable digest does not stop later rows being erased", () => {
    const root = mkdtempSync(join(tmpdir(), "steward-erase-bad-"));
    roots.push(root);
    const digest = {
      version: 1,
      repo: "o/r",
      drives: [],
      needs: [],
      queue: [],
      passes: [{ record: "p", said: "secret words", question: "q?" }],
      failures: [],
    } as unknown as StewardDigest;
    keepStewardRun("bad", digest, 1000, root);
    stateDb(root)
      .query(
        "UPDATE steward_runs SET digest = 'unreadable secret words' WHERE id = 'bad'",
      )
      .run();
    keepStewardRun("good", digest, 2000, root);
    expect(eraseStewardOutput(10_000_000_000, 1, root)).toBe(2);
    const read = readStewardDigest("good", root);
    expect(JSON.stringify(read)).not.toContain("secret words");
    const bad = stateDb(root)
      .query("SELECT digest FROM steward_runs WHERE id = 'bad'")
      .get() as { digest: string };
    expect(bad.digest).not.toContain("secret words");
    expect(bad.digest).toContain("removed after the retention period");
    expect(eraseStewardOutput(10_000_000_000, 1, root)).toBe(0);
  });

  test("an expired object that is not a digest is tombstoned, not marked erased untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "steward-erase-shape-"));
    roots.push(root);
    const digest = {
      version: 1,
      repo: "o/r",
      drives: [],
      needs: [],
      queue: [],
      passes: [],
      failures: [],
    } as unknown as StewardDigest;
    keepStewardRun("odd", digest, 1000, root);
    stateDb(root)
      .query("UPDATE steward_runs SET digest = ? WHERE id = 'odd'")
      .run(JSON.stringify({ passes: "secret words" }));
    expect(eraseStewardOutput(10_000_000_000, 1, root)).toBe(1);
    const row = stateDb(root)
      .query("SELECT digest FROM steward_runs WHERE id = 'odd'")
      .get() as { digest: string };
    expect(row.digest).not.toContain("secret words");
    expect(row.digest).toContain("removed after the retention period");
  });

  const malformed: Record<string, Record<string, unknown>> = {
    "passes that is not a list": { passes: "secret words" },
    "a pass that is not a mapping": { passes: ["secret words"] },
    "targets that is not a list": { targets: "secret output" },
    "a target that is not a mapping": { targets: ["secret output"] },
    "a lastPass that is not a mapping": {
      targets: [{ lastPass: "secret output" }],
    },
    "an output that is not a mapping": {
      targets: [{ lastPass: { output: "secret output" } }],
    },
  };

  for (const [name, fields] of Object.entries(malformed))
    test(`a valid envelope with ${name} is tombstoned`, () => {
      const root = mkdtempSync(join(tmpdir(), "steward-erase-nested-"));
      roots.push(root);
      const digest = {
        version: 1,
        repo: "o/r",
        drives: [],
        needs: [],
        queue: [],
        passes: [],
        failures: [],
      } as unknown as StewardDigest;
      keepStewardRun("nested", digest, 1000, root);
      stateDb(root)
        .query("UPDATE steward_runs SET digest = ? WHERE id = 'nested'")
        .run(JSON.stringify({ ...digest, ...fields }));
      expect(eraseStewardOutput(10_000_000_000, 1, root)).toBe(1);
      const row = stateDb(root)
        .query("SELECT digest FROM steward_runs WHERE id = 'nested'")
        .get() as { digest: string };
      expect(row.digest).not.toContain("secret");
      expect(row.digest).toContain("removed after the retention period");
    });
});
