// Each GritQL rule in grit/ runs alone against its fixtures: bad.ts must
// produce exactly the number of findings its first line states, good.ts none.
// The fixtures hold the shapes a rule must not match as well as the ones it
// must, so a widened pattern fails here before it floods the ratchet.
import { afterAll, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every scratch directory is removed after the file's tests, failed ones too.
const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const grit = join(import.meta.dir, "grit");
// Bun.which applies Windows' executable extensions to the installed shim.
const biome =
  Bun.which("biome", {
    PATH: join(import.meta.dir, "..", "..", "node_modules", ".bin"),
  }) ?? "biome";
const rules = readdirSync(grit)
  .filter((f) => f.endsWith(".grit"))
  .map((f) => f.slice(0, -".grit".length));

function findings(rule: string, fixture: string): string[] {
  const dir = scratch("grit-");
  copyFileSync(join(grit, `${rule}.grit`), join(dir, "rule.grit"));
  copyFileSync(join(grit, "fixtures", rule, fixture), join(dir, "f.ts"));
  writeFileSync(
    join(dir, "biome.json"),
    JSON.stringify({
      root: true,
      linter: { rules: { preset: "none" } },
      plugins: ["./rule.grit"],
    }),
  );
  const r = Bun.spawnSync(
    [biome, "lint", "--reporter=json", "--max-diagnostics=none", "f.ts"],
    { cwd: dir, stderr: "pipe" },
  );
  const report: unknown = JSON.parse(r.stdout.toString());
  const diagnostics =
    typeof report === "object" && report !== null && "diagnostics" in report
      ? report.diagnostics
      : undefined;
  if (!Array.isArray(diagnostics)) throw new Error(r.stderr.toString());
  return diagnostics
    .filter((d) => d.category === "plugin")
    .map((d) => String(d.message));
}

test("every rule has fixtures", () => {
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules)
    expect(readdirSync(join(grit, "fixtures", rule)).sort()).toEqual([
      "bad.ts",
      "good.ts",
    ]);
});

for (const rule of rules)
  for (const fixture of ["bad.ts", "good.ts"])
    test(`${rule}: ${fixture}`, () => {
      const text = readFileSync(join(grit, "fixtures", rule, fixture), "utf8");
      const expected = Number(/^\/\/ expect: (\d+)/.exec(text)?.[1]);
      const messages = findings(rule, fixture);
      expect(messages.length).toBe(expected);
      // The ratchet counts plugin findings by this tag.
      for (const m of messages)
        expect(m.startsWith(`jig/${rule}: `)).toBe(true);
    });
