// Jig's file-size counter keeps generated and vendored output outside its
// source scope (ADR-0007): such a file is fixed through its generator, never
// split by hand. The scope is a regular expression, so its path forms are
// checked here against the paths it must and must not match.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "../../modules/M1-gates-enforcement-ladder/reference/ratchet/ratchet-config.ts";
import type { RatchetConfig } from "../../modules/M1-gates-enforcement-ladder/reference/ratchet/ratchet-types.ts";

const wiring = parseJsonc(
  readFileSync(join(import.meta.dir, "ratchet.jsonc"), "utf8"),
) as RatchetConfig;
const counter = wiring.counters.find((c) => c.format === "file-lines");

function inScope(path: string): boolean {
  if (counter?.format !== "file-lines")
    throw new Error("no file-lines counter");
  const exclude = counter.exclude ? new RegExp(counter.exclude) : undefined;
  return new RegExp(counter.files).test(path) && !exclude?.test(path);
}

test("generated, vendored and fixture output is outside the source scope", () => {
  for (const path of [
    "src/example.generated.ts",
    "src/_generated/example.ts",
    "src/generated/example.ts",
    "generated/example.ts",
    "lib/vendor/js-yaml.mjs",
    "modules/M1/reference/x/fixtures/large.ts",
  ])
    expect([path, inScope(path)]).toEqual([path, false]);
});

test("maintained source whose path merely mentions generation stays in scope", () => {
  for (const path of [
    "scripts/check-generated-files.ts",
    "modules/M2-generated-artifact-freshness/reference/triad/generate-index.ts",
    "src/regenerated/example.ts",
    "src/generated.ts",
  ])
    expect([path, inScope(path)]).toEqual([path, true]);
});
