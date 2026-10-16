// Each rule here runs alone against its fixtures: bad.ts must produce exactly
// the number of findings its first line states, good.ts none. The fixtures
// hold the look-alikes a rule must leave alone as well as the shapes it must
// match, so a widened pattern fails here before it floods a ratchet.
import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  expectedFindings,
  FIXTURES,
  fixtureFiles,
  ruleFindings,
  ruleNames,
} from "../../../../lib/test-helpers/grit-fixtures.ts";

const dir = import.meta.dir;
const rules = ruleNames(dir);

test("every rule has fixtures", () => {
  expect(rules).toEqual([
    "catch-return-default",
    "json-parse-cast",
    "no-bare-throw-error",
    "no-message-branch",
    "stderr-ignore",
  ]);
  for (const rule of rules)
    expect(fixtureFiles(dir, rule)).toEqual([...FIXTURES]);
});

for (const rule of rules)
  for (const fixture of FIXTURES)
    test(`${rule}: ${fixture}`, () => {
      const messages = ruleFindings(dir, rule, fixture);
      expect(messages.length).toBe(
        expectedFindings(join(dir, "fixtures", rule, fixture)),
      );
      // A ratchet counts plugin findings by this tag.
      for (const m of messages)
        expect(m.startsWith(`jig/${rule}: `)).toBe(true);
    });
