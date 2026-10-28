/**
 * The configuration fit reads `routing` as do-item reads it: it refuses what
 * the routing loader refuses, and checks the raise lists the file declares
 * against the label taxonomy.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const TAXONOMY =
  "version: 1\ntypes:\n  - id: feature\n  - id: bug\nstatuses:\n  - id: todo\nflags:\n  - id: pii\n";

/** The fit's findings for a repository with this configuration and the taxonomy above. */
function findings(config: string): { id: string; message: string }[] {
  const dir = scratchRepo({
    ".config/jig.yaml": config,
    "label-taxonomy.yaml": TAXONOMY,
  });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  return (
    JSON.parse(run.out) as { findings: { id: string; message: string }[] }
  ).findings;
}

const rejection = (found: { id: string; message: string }[]) =>
  found.find((f) => f.id === "rejected:do-item (routing)")?.message;

test.each([
  [
    "a tier outside the list",
    "routing:\n  types:\n    bug: {tier: judgment}\n",
    "routing.types.bug.tier",
  ],
  [
    "a raise flags value that is not a list",
    "routing:\n  raise:\n    flags: 42\n",
    "routing.raise.flags",
  ],
  [
    "a runtime model row missing a tier",
    "routing:\n  models:\n    claude-code: {execution: sonnet}\n",
    "routing.models.claude-code",
  ],
])("%s is refused as do-item refuses it", (_, config, field) => {
  expect(rejection(findings(config))).toContain(field);
});

test("a valid routing section is not refused", () => {
  const found = findings(
    "routing:\n  types:\n    bug: {effort: high}\n  raise:\n    flags: [pii]\n",
  );
  expect(rejection(found)).toBeUndefined();
  expect(found.some((f) => f.id === "taxonomy:routing.raise.flags")).toBe(
    false,
  );
});

test("a raise label the taxonomy does not define is reported", () => {
  const found = findings("routing:\n  raise:\n    flags: [pii, secret]\n");
  expect(
    found.find((f) => f.id === "taxonomy:routing.raise.flags")?.message,
  ).toContain("secret, which label-taxonomy.yaml");
});

test("flags: catalog names no label to check", () => {
  const found = findings("routing:\n  raise:\n    flags: catalog\n");
  expect(found.some((f) => f.id.startsWith("taxonomy:routing"))).toBe(false);
  expect(rejection(found)).toBeUndefined();
});
