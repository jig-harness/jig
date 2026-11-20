import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFixtureNameIndex } from "../fixture-registry-index.ts";
import { registerFixtureScope } from "../test-fixture-registry.ts";

test("a missing index metadata row refuses registration", () => {
  const base = mkdtempSync(join(tmpdir(), "fixture-index-"));
  const store = join(base, "registry");
  mkdirSync(join(store, "legacy"), { recursive: true });
  const initialized = withFixtureNameIndex(store, (index) => index.count());
  expect(initialized).toEqual({ ok: true, value: 1 });
  const db = new Database(`${store}.index.sqlite`);
  try {
    db.exec("DELETE FROM fixture_registry_index WHERE id = 1");
  } finally {
    db.close();
  }
  expect(
    registerFixtureScope(join(base, "new"), undefined, store),
  ).toMatchObject({
    ok: false,
    failure: {
      code: "fixture-index",
      reason: expect.stringContaining("missing or invalid registry count"),
    },
  });
  expect(readdirSync(store)).toEqual(["legacy"]);
});
