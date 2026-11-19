/** A stored need's `covers` is a list of items; a snapshot holding anything else is rewritten by the next tick, never read. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { buildLine } from "../lib/line.ts";
import { readLine, writeLine } from "../lib/line-store.ts";
import { closeStateDb } from "../lib/state.ts";
import { input, report } from "./line-fixtures.ts";

function readWith(covers: unknown): boolean {
  const root = mkdtempSync(join(tmpdir(), "jig-line-covers-"));
  try {
    const line = buildLine(
      input({
        reports: [
          report({
            actions: [
              {
                stage: "notify",
                cause: "release-owed",
                target: "#1",
                record: "tracker",
                reason: "Release v1.0.0 is owed its tag.",
                evidence: { tag: "v1.0.0" },
              },
            ],
          }),
        ],
      }),
    );
    const [need] = line.needs;
    expect(need).toBeDefined();
    const stored = { ...line, needs: [{ ...need, covers }] };
    writeLine(stored as unknown as typeof line, "{}", root);
    return readLine(root).ok;
  } finally {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
}

it("reads a need whose covers is a list of items", () => {
  expect(readWith(["#1", "#2"])).toBe(true);
});

it("refuses a need whose covers is not a list of items", () => {
  for (const covers of [{}, 1, [1], "#1"]) expect(readWith(covers)).toBe(false);
});
