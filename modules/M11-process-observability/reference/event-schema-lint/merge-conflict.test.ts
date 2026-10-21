import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const gate = join(import.meta.dir, "check-events.ts");
const schema = resolve(import.meta.dir, "../../templates/event-schema.yaml");

function validate(fields: Record<string, string>, expected: number) {
  const dir = mkdtempSync(join(tmpdir(), "jig-conflict-schema-"));
  try {
    const stream = join(dir, "events.log");
    writeFileSync(
      stream,
      `${Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}\n`,
    );
    const child = Bun.spawnSync([process.execPath, gate, stream], {
      env: { ...process.env, SCHEMA: schema },
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(child, expected);
    return child.stdout.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const event = {
  type: "merge_conflict",
  operation: "rebase",
  path: "src/index.ts",
  cause: "overlap",
};

test("the shipped event schema accepts a conflict without optional PR or decision", () => {
  expect(validate(event, 0)).toContain("1 event(s) valid");
});

for (const field of ["operation", "path", "cause"]) {
  test(`the shipped event schema rejects a conflict missing ${field}`, () => {
    const fields: Record<string, string> = { ...event };
    delete fields[field];
    expect(validate(fields, 1)).toContain(`missing required field '${field}'`);
    expect(validate({ ...event, [field]: "" }, 1)).toContain(
      `empty required field '${field}'`,
    );
  });
}
