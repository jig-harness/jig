// Each GritQL rule in grit/ runs alone against its fixtures: bad.ts must
// produce exactly the number of findings its first line states, good.ts none.
// The fixtures hold the shapes a rule must not match as well as the ones it
// must, so a widened pattern fails here before it floods the ratchet. The
// error-handling rules live with M15 (modules/M15-contracts-errors/reference/
// lint-rules/) and have the same self-test beside them.
import { expect, test } from "bun:test";
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
