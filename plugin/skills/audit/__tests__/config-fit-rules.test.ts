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
  return fitRun(config).findings;
}

/** The fit's findings and its exit status. */
function fitRun(config: string): {
  findings: { id: string; message: string; severity: string }[];
  code: number | null;
} {
  const dir = scratchRepo({ ".config/jig.yaml": config });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  return {
    code: run.code,
    findings: (
      JSON.parse(run.out) as {
        findings: { id: string; message: string; severity: string }[];
      }
    ).findings,
  };
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

const ADOPT_ID = "derivation:pull_requests.trusted_automation:adopt";

// The one adopt finding of a report: a second one with the same id would
// give the operator two instructions, so more than one fails here.
function adoptFinding(found: ReturnType<typeof findings>) {
  const matching = found.filter((f) => f.id === ADOPT_ID);
  expect(matching).toHaveLength(1);
  const [only] = matching;
  if (only === undefined) throw new Error("no adopt finding");
  return only;
}

const PROCEDURE =
  "the Trusted automation section of plugin/CONFIGURATION.md in the installed plugin";

const OPT_OUT_MESSAGE = (labels: string) =>
  `dispatch.adopt.trusted_automation is false: no automatic start is left for a listed bot's pull request. Its first drive, a restart after a head that moved and a conflict repair all wait for a person, and a pickup handoff cannot start it. Before switching, pause dispatch on every host that dispatches this repository, let active ticks finish, stop any drive already running on a listed bot's pull request and retire every outstanding drive and rearm request${labels}. Review the install inputs and every command a start or restart would run, then, for each listed bot's pull request you decide should be driven, start its first drive directly, and restart each drive whose stop allows a restart (not one a person stopped, one converged on its verified head that is still mergeable, or a superseded driver) directly; resume dispatch once the policy is in effect on every host. The full procedure, which names the trusted baseline and the restart rules, is in ${PROCEDURE}`;

const ON_MESSAGE = OPT_OUT_MESSAGE("");

const OFF_MESSAGE = OPT_OUT_MESSAGE(
  " (labels are off, so no label starts a drive)",
);

const ADOPTION_OFF = (by: string) =>
  `Author-based adoption is off, so a listed bot's pull request with no ledger is not adopted by its author. Its first drive starts when a person ${by}arms it by hand, or when a completed process pickup starts it for its own same-repository pull request; a drive that stopped in an eligible state can restart from its ledger. Set dispatch.adopt.trusted_automation: false to require a person to start every listed bot's drive, and review its install inputs first.`;

test("the trusted automation adoption opt-out is accepted and reported", () => {
  const run = fitRun(
    'dispatch:\n  labels: { enabled: true }\n  adopt: { enabled: true, trusted_automation: false }\npull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
  );
  const found = run.findings;
  expect(run.code).toBe(0);
  expect(found.filter((finding) => finding.severity === "error")).toEqual([]);
  const adopt = adoptFinding(found);
  expect(adopt.severity).toBe("info");
  // The whole message is pinned: a phrase-by-phrase check passes whatever
  // is appended to the guidance, so a route the guidance must not offer
  // would go unseen.
  expect(adopt.message).toBe(ON_MESSAGE);
});

test("the opt-out with labels off has no label route, and refusal hides the guidance", () => {
  const direct = adoptFinding(
    findings(
      'dispatch:\n  adopt: { enabled: false, trusted_automation: false }\npull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
    ),
  );
  expect(direct.message).toBe(OFF_MESSAGE);
  const plain = adoptFinding(
    findings(
      'dispatch:\n  adopt: { enabled: false }\npull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
    ),
  );
  expect(plain.message).toBe(ADOPTION_OFF(""));
  const labelled = adoptFinding(
    findings(
      'dispatch:\n  labels: { enabled: true }\n  adopt: { enabled: false, trusted_automation: false }\npull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
    ),
  );
  expect(labelled.message).toBe(ON_MESSAGE);
  const plainLabelled = adoptFinding(
    findings(
      'dispatch:\n  labels: { enabled: true }\n  adopt: { enabled: false }\npull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
    ),
  );
  expect(plainLabelled.message).toBe(ADOPTION_OFF("labels it drive or "));
  const refusedRun = fitRun(
    'dispatch:\n  labels: { enabled: true }\n  adopt: { enabled: true, trusted_automation: 3 }\npull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
  );
  expect(refusedRun.code).toBe(1);
  const refused = refusedRun.findings;
  expect(refused.map((f) => f.id)).not.toContain(
    "derivation:pull_requests.trusted_automation:adopt",
  );
  const rejection = refused.find((f) => f.id === "rejected:dispatch");
  expect(rejection?.severity).toBe("error");
  expect(rejection?.message).toContain("dispatch.adopt.trusted_automation");
});
