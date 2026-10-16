// Each GritQL rule in grit/ runs alone against its fixtures: bad.ts must
// produce exactly the number of findings its first line states, good.ts none.
// The fixtures hold the shapes a rule must not match as well as the ones it
// must, so a widened pattern fails here before it floods the ratchet. The
// error-handling rules live with M15 (modules/M15-contracts-errors/reference/
// lint-rules/) and have the same self-test beside them.
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectedFindings,
  FIXTURES,
  fixtureFiles,
  ruleFindings,
  ruleNames,
} from "../../lib/test-helpers/grit-fixtures.ts";

const grit = join(import.meta.dir, "grit");
const rules = ruleNames(grit);

test("every rule has fixtures", () => {
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules)
    expect(fixtureFiles(grit, rule)).toEqual([...FIXTURES]);
});

for (const rule of rules)
  for (const fixture of FIXTURES)
    test(`${rule}: ${fixture}`, () => {
      const messages = ruleFindings(grit, rule, fixture);
      expect(messages.length).toBe(
        expectedFindings(join(grit, "fixtures", rule, fixture)),
      );
      // The ratchet counts plugin findings by this tag.
      for (const m of messages)
        expect(m.startsWith(`jig/${rule}: `)).toBe(true);
    });

// GritQL sees absolute paths, so no-bare-signal-handlers exempts the cleanup
// kernel by path suffix. Only the kernel itself may carry that suffix. The
// listing is NUL-delimited: by default git quotes a path with non-ASCII bytes,
// and a quoted look-alike would slip past the end-anchored pattern.
function exemptFiles(root: string, exempt: RegExp): string[] {
  const listing = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, stderr: "pipe" },
  );
  if (listing.exitCode !== 0)
    throw new Error(`git ls-files failed: ${listing.stderr.toString()}`);
  return listing.stdout
    .toString()
    .split("\0")
    .filter((file) => file && exempt.test(`${root}/${file}`));
}

const rule = readFileSync(join(grit, "no-bare-signal-handlers.grit"), "utf8");
const source = /\$filename <: r"([^"]+)"/.exec(rule)?.[1];

test("no-bare-signal-handlers exempts only the cleanup kernel", () => {
  if (!source) throw new Error("exemption pattern not found");
  const root = join(import.meta.dir, "..", "..");
  expect(exemptFiles(root, new RegExp(source))).toEqual([
    "plugin/shared/cleanup.ts",
  ]);
});

test("the exemption census sees a look-alike under a non-ASCII directory", () => {
  if (!source) throw new Error("exemption pattern not found");
  const root = mkdtempSync(join(tmpdir(), "jig-grit-census-"));
  try {
    const init = Bun.spawnSync(["git", "init", "-q"], {
      cwd: root,
      stderr: "pipe",
    });
    if (init.exitCode !== 0) throw new Error("git init failed");
    const lookAlike = join(root, "é", "plugin", "shared");
    mkdirSync(lookAlike, { recursive: true });
    writeFileSync(join(lookAlike, "cleanup.ts"), "");
    expect(exemptFiles(root, new RegExp(source))).toEqual([
      "é/plugin/shared/cleanup.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
