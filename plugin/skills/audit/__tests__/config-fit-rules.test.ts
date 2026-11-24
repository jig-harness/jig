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
function findings(
  config: string,
): { id: string; message: string; severity: string }[] {
  const dir = scratchRepo({ ".config/jig.yaml": config });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  return (
    JSON.parse(run.out) as {
      findings: { id: string; message: string; severity: string }[];
    }
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

const ON_MESSAGE =
  "dispatch.adopt.trusted_automation is false: no automatic start is left for a listed bot's pull request. Its first drive, a restart after a head that moved and a conflict repair all wait for a person, and a pickup handoff cannot start it. Before switching, pause dispatch on every host that dispatches this repository (the change probe's ticks included) and let each host's active ticks finish: a tick that already passed its fresh read can still complete an automatic start under the old policy. Review the install inputs (manifests, installer configuration, lockfiles) against a trusted baseline, and the inputs of the merge of the base too, since the drive merges it and may install from the merged tree, before you start the drive directly from a verified checkout. Recheck whenever the head, the base or a conflict resolution changes the inputs, and stop the drive if they move. Retire every outstanding drive and rearm request while dispatch is paused: one made before the switch can still start a drive without a new review. A drive or rearm label is not a substitute: it pins neither the reviewed head nor the base the drive merges, and a rearm label needs a trusted request bound to an eligible stop, so the dispatcher may start from inputs nobody reviewed. A drive a person stopped stays stopped, and a converged drive needs no restart: restart any other stopped drive only by starting it directly after the same review.";

const OFF_MESSAGE =
  "dispatch.adopt.trusted_automation is false: no automatic start is left for a listed bot's pull request. Its first drive, a restart after a head that moved and a conflict repair all wait for a person, and a pickup handoff cannot start it. Before switching, pause dispatch on every host that dispatches this repository (the change probe's ticks included) and let each host's active ticks finish: a tick that already passed its fresh read can still complete an automatic start under the old policy. Review the install inputs (manifests, installer configuration, lockfiles) against a trusted baseline, and the inputs of the merge of the base too, since the drive merges it and may install from the merged tree, before you start the drive directly from a verified checkout. Recheck whenever the head, the base or a conflict resolution changes the inputs, and stop the drive if they move. Labels are off (dispatch.labels.enabled), so no label starts a drive; retire any request before turning them on again. A drive a person stopped stays stopped, and a converged drive needs no restart: restart any other stopped drive only by starting it directly after the same review.";

test("the trusted automation adoption opt-out is accepted and reported", () => {
  const found = findings(
    'dispatch:\n  labels: { enabled: true }\n  adopt: { enabled: true, trusted_automation: false }\npull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
  );
  expect(found.filter((finding) => finding.severity === "error")).toEqual([]);
  const adopt = found.find(
    (finding) =>
      finding.id === "derivation:pull_requests.trusted_automation:adopt",
  );
  expect(adopt?.severity).toBe("info");
  // The whole message is pinned: a phrase-by-phrase check passes whatever
  // is appended to the guidance, so a route the guidance must not offer
  // would go unseen.
  expect(adopt?.message).toBe(ON_MESSAGE);
});

test("the opt-out with labels off has no label route, and refusal hides the guidance", () => {
  const direct = findings(
    'dispatch:\n  adopt: { enabled: false, trusted_automation: false }\npull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
  ).find((f) => f.id === "derivation:pull_requests.trusted_automation:adopt");
  expect(direct?.message).toBe(OFF_MESSAGE);
  const plain = findings(
    'dispatch:\n  adopt: { enabled: false }\npull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
  ).find((f) => f.id === "derivation:pull_requests.trusted_automation:adopt");
  expect(plain?.message).toContain("pickup");
  const refused = findings(
    'dispatch:\n  labels: { enabled: true }\n  adopt: { enabled: true, trusted_automation: 3 }\npull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
  );
  expect(refused.map((f) => f.id)).not.toContain(
    "derivation:pull_requests.trusted_automation:adopt",
  );
  const rejection = refused.find((f) => f.id === "rejected:dispatch");
  expect(rejection?.severity).toBe("error");
  expect(rejection?.message).toContain("dispatch.adopt.trusted_automation");
});
