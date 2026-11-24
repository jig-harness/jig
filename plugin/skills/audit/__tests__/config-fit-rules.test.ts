/**
 * The configuration fit refuses a malformed rule in a field the rule matcher
 * reads, naming the field, as the shared configuration reader does at load;
 * and a malformed review gate, as do-item refuses it.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The fit's findings for a repository with this configuration. */
function findings(config: string): { id: string; message: string }[] {
  const dir = scratchRepo({ ".config/jig.yaml": config });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  return (
    JSON.parse(run.out) as { findings: { id: string; message: string }[] }
  ).findings;
}

const RULES = "rejected:every skill (rule matcher)";

test("a rule naming an unknown fact is refused, naming the field", () => {
  const found = findings(
    "pull_requests:\n  base_rules:\n    - when: { colour: [red] }\n      base: release\n",
  );
  expect(found.find((f) => f.id === RULES)?.message).toContain(
    "pull_requests.base_rules[0].when.colour is not a fact a rule may test",
  );
});

test("a rule value of the wrong kind is refused, naming the field", () => {
  const found = findings("work_batch:\n  solo_flags: privacy\n");
  expect(found.find((f) => f.id === RULES)?.message).toContain(
    "work_batch.solo_flags must be a list",
  );
});

test("well-formed rules are accepted", () => {
  const found = findings(
    "do_item:\n  gates:\n    - labels: [db]\n      skill: db-review\n",
  );
  expect(found.some((f) => f.id === RULES)).toBe(false);
  expect(found.some((f) => f.id === "rejected:do-item (review gates)")).toBe(
    false,
  );
});

test("a review gate without its skill is refused", () => {
  const found = findings("do_item:\n  gates:\n    - labels: [db]\n");
  expect(
    found.find((f) => f.id === "rejected:do-item (review gates)")?.message,
  ).toContain("do_item.gates[0].skill must name a skill");
});

test("a trusted automation list that does not read is refused, naming the setting", () => {
  const found = findings("pull_requests:\n  trusted_automation: renovate\n");
  expect(
    found.find((f) => f.id === "rule:pull_requests.trusted_automation")
      ?.message,
  ).toContain("pull_requests.trusted_automation must be a list");
});

test("a trusted automation list with no reviewer app and no adoption is said to change nothing yet", () => {
  const found = findings(
    'pull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
  ).map((f) => f.id);
  expect(found).toContain(
    "derivation:pull_requests.trusted_automation:witness",
  );
  expect(found).toContain("derivation:pull_requests.trusted_automation:adopt");
  const witnessed = findings(
    'review:\n  reviewer_app: example-review\npull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
  ).map((f) => f.id);
  expect(witnessed).not.toContain(
    "derivation:pull_requests.trusted_automation:witness",
  );
});
