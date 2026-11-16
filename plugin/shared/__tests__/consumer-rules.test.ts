/**
 * The shared configuration reader refuses a malformed rule in any field the
 * rule matcher reads before a skill acts on it, naming the field and the
 * file that set it; a well-formed one loads.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layeredConfig } from "../consumer.ts";

const root = mkdtempSync(join(tmpdir(), "consumer-rules-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = { JIG_USER_LAYER: "off" };
const read = (text: string) => () => layeredConfig(root, env, text);

test("loads a configuration whose rules are well formed", () => {
  const config = read(
    "pull_requests:\n  base_rules:\n    - when: { labels: [hotfix] }\n      base: release\nwork_batch:\n  solo_flags: [privacy]\n",
  )();
  expect(config.hasRepository).toBe(true);
});

test.each([
  [
    "pull_requests:\n  base_rules:\n    - when: { colour: [red] }\n      base: release\n",
    "pull_requests.base_rules[0].when.colour is not a fact a rule may test (labels)",
  ],
  [
    "do_item:\n  gates:\n    - labels: kind:db\n      skill: x\n",
    "do_item.gates[0].labels must be a nonempty list of label names",
  ],
  [
    "routing:\n  raise:\n    flags: everything\n",
    "routing.raise.flags must be a list of distinct nonempty label names, or catalog",
  ],
])("refuses %j, naming the field and its file", (text, why) => {
  expect(read(text)).toThrow(`${why}: ${join(root, ".config", "jig.yaml")}`);
});
