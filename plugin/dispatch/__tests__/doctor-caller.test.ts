/** The drive doctor the dispatcher runs keeps the tick's outbound caller, so its calls are not read as a timer's. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCaller } from "../../shared/outbound/ledger.ts";
import { readHolders } from "../lib/sources/doctor.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("the doctor child runs under the caller the tick carries", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-caller-"));
  roots.push(root);
  const seen = join(root, "caller.txt");
  const script = join(root, "doctor.ts");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, process.env.JIG_OUTBOUND_CALLER ?? "");\nconsole.log("[]");\n`,
  );
  const before = process.env.JIG_DISPATCH_DOCTOR_SCRIPT;
  process.env.JIG_DISPATCH_DOCTOR_SCRIPT = script;
  try {
    await withCaller("tick:test-run", () => readHolders(root, 30));
  } finally {
    if (before === undefined) delete process.env.JIG_DISPATCH_DOCTOR_SCRIPT;
    else process.env.JIG_DISPATCH_DOCTOR_SCRIPT = before;
  }
  expect(readFileSync(seen, "utf8")).toBe("tick:test-run");
});
