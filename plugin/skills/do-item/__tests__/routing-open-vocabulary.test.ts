/**
 * The open model vocabulary (design/provider-accounts.md): a model outside
 * the known families is routed once configuration says which M0 tier it is,
 * at the host layer, the repository layer and a stage's row, resolved in the
 * documented order; an unmapped one is refused naming the key to set; and a
 * `routing.family_tiers` configuration reads as before.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLayeredConfig } from "../../../shared/config-layers.ts";
import { deriveRoute, type RouteFacts } from "../scripts/determine_route.ts";
import { parseRouting, parseRoutingModels } from "../scripts/lib/routing.ts";
import { parseWorkTypes } from "../scripts/lib/work-types.ts";

const OUTSIDE = "z-ai/glm-5.3-flash";
const OTHER = "moonshot/kimi-k3";

const facts = (over: Partial<RouteFacts> = {}): RouteFacts => ({
  agent: "general-purpose",
  type: "spike",
  labels: [],
  catalog: { flags: [], reviews: [] },
  hitl: "hitl",
  knownSizes: ["xs", "small", "medium"],
  batchSizes: ["xs", "small", "medium"],
  runtime: "codex",
  ...over,
});

const rules = (config: Record<string, unknown>) =>
  parseRouting(config, parseWorkTypes(config));

let dir = "";
let home = "";
let repo = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "routing-open-vocabulary-"));
  home = join(dir, "home");
  repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(join(repo, ".config"), { recursive: true });
  mkdirSync(join(repo, ".git"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The merged configuration of a host file and a repository file, read as the skills read it. */
function layered(host: string | null, repository: string | null) {
  if (host !== null) writeFileSync(join(home, "jig.yaml"), host);
  if (repository !== null)
    writeFileSync(join(repo, ".config", "jig.yaml"), repository);
  return loadLayeredConfig(repo, { JIG_HOME: home }).values;
}

describe("a model outside the families", () => {
  it("is routed with the tier the repository file maps it to", () => {
    const config = layered(
      null,
      `routing:
  models:
    codex: { complex: "${OUTSIDE}" }
  model_tiers:
    codex:
      "${OUTSIDE}": { tier: strategic, reason: "the provider's flagship" }
`,
    );
    const route = deriveRoute(facts(), rules(config));
    expect(route.tier).toBe("complex");
    expect(route.model).toBe(OUTSIDE);
    expect(route.runtime_model).toBe(OUTSIDE);
    expect(rules(config).reported).toContain(
      `routing.model_tiers.codex."${OUTSIDE}" reads "${OUTSIDE}" as a strategic family: the provider's flagship`,
    );
  });

  it("is refused, naming the key to set, when no layer maps it", () => {
    const config = layered(
      null,
      `routing:\n  models:\n    codex: { complex: "${OUTSIDE}" }\n`,
    );
    expect(() => rules(config)).toThrow(
      `routing.models.codex.complex: ${OUTSIDE} is not a model codex knows (luna, terra, sol, astra); name one of those, or say which M0 tier ${OUTSIDE} is by setting routing.model_tiers.codex."${OUTSIDE}" to { tier: scout | execution | strategic | judgment, reason }`,
    );
  });

  it("is refused for a runtime that takes aliases, with the same key named", () => {
    expect(() =>
      rules({
        routing: { models: { "claude-code": { complex: OUTSIDE } } },
      }),
    ).toThrow(`routing.model_tiers.claude-code."${OUTSIDE}"`);
  });

  it("refuses controls in an undeclared selected model", () => {
    const selected = "outside\u202Emodel";
    expect(() =>
      rules({ routing: { models: { codex: { complex: selected } } } }),
    ).toThrow(
      "routing.models.codex.complex must be a model: one word that does not start with a dash or contain control or bidirectional characters",
    );
  });

  it("refuses an unpaired surrogate in a selected model but keeps a valid pair", () => {
    for (const selected of ["model\uD800", "model\uD801"])
      expect(() =>
        rules({ routing: { models: { codex: { complex: selected } } } }),
      ).toThrow("routing.models.codex.complex must be a model");
    expect(() =>
      rules({ routing: { models: { codex: { complex: "model\u{1F600}" } } } }),
    ).not.toThrow("must be a model");
  });

  it("reports non-string selected models without coercing configuration values", () => {
    const hostile = {
      toString: () => {
        throw new Error("must not coerce");
      },
    };
    expect(() =>
      rules({ routing: { models: { codex: { complex: hostile } } } }),
    ).toThrow("routing.models.codex.complex must be a model");
    expect(() =>
      rules({ routing: { models: { codex: { complex: hostile } } } }),
    ).toThrow("(got object)");
  });

  it("keeps a declared outside model available to route derivation", () => {
    const config = {
      routing: {
        models: { "claude-code": { complex: OUTSIDE } },
        model_tiers: {
          "claude-code": {
            [OUTSIDE]: { tier: "strategic", reason: "a provider model" },
          },
        },
      },
    };
    expect(parseRoutingModels(config)["claude-code"]?.complex).toBe(OUTSIDE);
    expect(
      deriveRoute(facts({ runtime: "claude-code" }), rules(config)),
    ).toMatchObject({ model: OUTSIDE, runtime_model: OUTSIDE });
  });

  it("is refused for a stage's row too", () => {
    expect(() =>
      rules({
        routing: {
          stages: { steward: { models: { codex: { complex: OUTSIDE } } } },
        },
      }),
    ).toThrow(
      `routing.stages.steward.models.codex.complex: ${OUTSIDE} is not a model codex knows`,
    );
  });

  it("is never a Scout model's route, however it is declared", () => {
    expect(() =>
      rules({
        routing: {
          models: { codex: { simple: OUTSIDE } },
          model_tiers: {
            codex: { [OUTSIDE]: { tier: "scout", reason: "a small model" } },
          },
        },
      }),
    ).toThrow(/Scout family.*no routing.model_tiers or routing.family_tiers/);
  });

  it("needs a reason, like a family_tiers entry", () => {
    expect(() =>
      rules({
        routing: {
          model_tiers: { codex: { [OUTSIDE]: { tier: "strategic" } } },
        },
      }),
    ).toThrow(`routing.model_tiers.codex."${OUTSIDE}".reason must say why`);
  });

  it("escapes controls in an unused declaration's audit report", () => {
    const declared = "unused\u0080\u202Emodel";
    const reported = rules({
      routing: {
        model_tiers: {
          codex: { [declared]: { tier: "strategic", reason: "reserved" } },
        },
      },
    }).reported.join("\n");
    expect(reported).toContain(
      '"unused\\u0080\\u202emodel" reads "unused\\u0080\\u202emodel"',
    );
    expect(reported).not.toContain(declared);
  });

  it("keeps declaration reasons as plain report data", () => {
    const reported = rules({
      routing: {
        model_tiers: {
          codex: {
            "gpt-house": {
              tier: "strategic",
              reason: "**not a separate result**\nnext line",
            },
          },
        },
      },
    }).reported.join("\n");
    expect(reported).toContain('"**not a separate result**\\nnext line"');
  });

  it("keeps declared identifiers as plain report data", () => {
    const reported = rules({
      routing: {
        model_tiers: {
          codex: { "model**name": { tier: "strategic", reason: "reserved" } },
        },
      },
    }).reported.join("\n");
    expect(reported).toContain("model**name");
  });

  it("keeps an unused legacy declaration from changing a selected model route", () => {
    expect(
      parseRoutingModels({
        routing: {
          models: { codex: { complex: OUTSIDE } },
          model_tiers: {
            codex: {
              "-retired": {
                tier: "strategic",
                reason: "a retained legacy key",
              },
              [OUTSIDE]: { tier: "strategic", reason: "the selected model" },
            },
          },
          family_tiers: {
            codex: {
              "-older-retired": {
                tier: "strategic",
                reason: "a retained legacy key",
              },
            },
          },
        },
      }).codex?.complex,
    ).toBe(OUTSIDE);
  });
});

describe("the host and the repository layers", () => {
  const HOST = `routing:
  model_tiers:
    codex:
      "${OUTSIDE}": { tier: strategic, reason: "host's key reaches it" }
      "${OTHER}": { tier: strategic, reason: "host's key reaches it" }
  stages:
    steward:
      models:
        codex: { complex: "${OUTSIDE}", standard: "${OTHER}" }
`;

  it("lets a host's mapping serve every repository that sets nothing", () => {
    const config = layered(HOST, null);
    expect(parseRoutingModels(config, "steward").codex).toMatchObject({
      complex: OUTSIDE,
      standard: OTHER,
    });
  });

  it("lets the repository's cell win over the host's for the same stage", () => {
    const config = layered(
      HOST,
      `routing:
  stages:
    steward:
      models:
        codex: { complex: "${OTHER}" }
`,
    );
    const row = parseRoutingModels(config, "steward").codex;
    expect(row?.complex).toBe(OTHER);
    // The cell the repository left out is still the host's.
    expect(row?.standard).toBe(OTHER);
  });

  it("lets a repository retier a model the host mapped", () => {
    const config = layered(
      HOST.slice(0, HOST.indexOf("  stages:")),
      `routing:
  model_tiers:
    codex:
      "${OUTSIDE}": { tier: execution, reason: "cheaper here" }
`,
    );
    expect(rules(config).familyTiers.codex?.[OUTSIDE]?.tier).toBe("execution");
    expect(rules(config).familyTiers.codex?.[OTHER]?.tier).toBe("strategic");
  });

  it("reads a stage's cell over the all-stages cell, whichever layer set each", () => {
    // The host sets the steward's cell; the repository, a higher layer, sets
    // the all-stages cell. The stage's row is the more specific one.
    const config = layered(
      HOST,
      `routing:
  models:
    codex: { simple: gpt-house, complex: astra }
  model_tiers:
    codex:
      gpt-house: { tier: execution, reason: "the house model" }
`,
    );
    expect(parseRoutingModels(config, "steward").codex?.complex).toBe(OUTSIDE);
    // A cell the steward's row leaves out is the all-stages cell, not the default.
    expect(parseRoutingModels(config, "steward").codex?.simple).toBe(
      "gpt-house",
    );
    expect(parseRoutingModels(config, "pickup").codex?.complex).toBe("astra");
    expect(parseRoutingModels(config).codex?.complex).toBe("astra");
  });

  it("refuses a stage whose models is null, which would erase a lower layer", () => {
    expect(() =>
      parseRoutingModels({
        routing: { stages: { steward: { models: null } } },
      }),
    ).toThrow("routing.stages.steward.models is null");
  });

  it("refuses routing.stages set to null, which would erase a lower layer", () => {
    expect(() => parseRoutingModels({ routing: { stages: null } })).toThrow(
      "routing.stages is null",
    );
  });

  it("refuses routing.model_tiers set to null, which would erase a lower layer", () => {
    expect(() =>
      parseRoutingModels({ routing: { model_tiers: null } }),
    ).toThrow("routing.model_tiers is null");
  });

  it("reads a repository's routing: null as a whole-section reset to the defaults", () => {
    const config = layered(HOST, "routing: null\n");
    expect(config.routing).toBeNull();
    expect(rules(config).declared).toBe(false);
    expect(parseRoutingModels(config, "steward").codex).toEqual({
      simple: "terra",
      standard: "terra",
      complex: "sol",
    });
    expect(parseRoutingModels(config, "pickup").codex).toEqual(
      parseRoutingModels(config, "steward").codex,
    );
    expect(parseRoutingModels(config).codex).toEqual(
      parseRoutingModels(config, "steward").codex,
    );
  });

  it("keeps the environment's declaration and drops the host's after a repository null", () => {
    writeFileSync(
      join(home, "jig.yaml"),
      `routing:
  model_tiers:
    codex:
      gpt-house: { tier: execution, reason: "the house model" }
`,
    );
    writeFileSync(
      join(repo, ".config", "jig.yaml"),
      "routing:\n  model_tiers: null\n",
    );
    const config = loadLayeredConfig(repo, {
      JIG_HOME: home,
      JIG__ROUTING__MODEL_TIERS__CODEX__OTHER_HOUSE__TIER: "execution",
      JIG__ROUTING__MODEL_TIERS__CODEX__OTHER_HOUSE__REASON: "from the run",
    }).values;
    const tiers = (
      (config.routing as Record<string, unknown>).model_tiers as Record<
        string,
        Record<string, unknown>
      >
    ).codex as Record<string, unknown>;
    expect(Object.keys(tiers)).toEqual(["other_house"]);
    expect(() => parseRoutingModels(config)).not.toThrow();
  });

  it("routes a model the environment declares after a repository null, and refuses one only the host declared", () => {
    const run = (selected: string) => {
      writeFileSync(
        join(home, "jig.yaml"),
        `routing:
  models:
    codex:
      standard: ${selected}
  model_tiers:
    codex:
      gpt-house: { tier: execution, reason: "the house model" }
`,
      );
      writeFileSync(
        join(repo, ".config", "jig.yaml"),
        "routing:\n  model_tiers: null\n",
      );
      return loadLayeredConfig(repo, {
        JIG_HOME: home,
        JIG__ROUTING__MODEL_TIERS__CODEX__OTHER_HOUSE__TIER: "execution",
        JIG__ROUTING__MODEL_TIERS__CODEX__OTHER_HOUSE__REASON: "from the run",
      }).values;
    };
    expect(parseRoutingModels(run("other_house")).codex?.standard).toBe(
      "other_house",
    );
    expect(() => parseRoutingModels(run("gpt-house"))).toThrow(
      /routing\.models\.codex\.standard: gpt-house is not a model codex knows[^\n]*by setting routing\.model_tiers\.codex\.gpt-house to \{ tier:/,
    );
  });

  it("routes a model the host declared under family_tiers after a repository resets model_tiers", () => {
    writeFileSync(
      join(home, "jig.yaml"),
      `routing:
  models:
    codex:
      standard: gpt-house
  model_tiers:
    codex:
      host_only: { tier: execution, reason: "the host's own table" }
  family_tiers:
    codex:
      gpt-house: { tier: execution, reason: "the house model" }
`,
    );
    writeFileSync(
      join(repo, ".config", "jig.yaml"),
      "routing:\n  model_tiers: null\n",
    );
    const config = loadLayeredConfig(repo, {
      JIG_HOME: home,
      JIG__ROUTING__MODEL_TIERS__CODEX__OTHER_HOUSE__TIER: "execution",
      JIG__ROUTING__MODEL_TIERS__CODEX__OTHER_HOUSE__REASON: "from the run",
    }).values;
    expect(parseRoutingModels(config).codex?.standard).toBe("gpt-house");
    const tiers = JSON.stringify(config);
    expect(tiers).not.toContain("host_only");
    expect(tiers).toContain("other_house");
  });

  it("lets a run's environment win over both files", () => {
    layered(HOST, null);
    const config = loadLayeredConfig(repo, {
      JIG_HOME: home,
      JIG__ROUTING__STAGES__STEWARD__MODELS__CODEX__COMPLEX: "sol",
    }).values;
    expect(parseRoutingModels(config, "steward").codex?.complex).toBe("sol");
  });

  it("leaves a stage with no row on the all-stages row", () => {
    const config = layered(HOST, null);
    expect(parseRoutingModels(config, "rearm").codex).toEqual({
      simple: "terra",
      standard: "terra",
      complex: "sol",
    });
  });
});

describe("stage rows", () => {
  it("refuses a stage the dispatcher does not launch", () => {
    expect(() =>
      rules({ routing: { stages: { review: { models: {} } } } }),
    ).toThrow("routing.stages.review is not a field of routing.stages");
  });

  it("refuses a stage's cell that would run a stricter tier on a cheaper model", () => {
    expect(() =>
      rules({
        routing: {
          models: { "claude-code": { standard: "opus" } },
          stages: {
            steward: { models: { "claude-code": { complex: "sonnet" } } },
          },
        },
      }),
    ).toThrow(
      "routing.stages.steward.models.claude-code.complex: the complex tier runs on sonnet (M0 execution)",
    );
  });

  it("reports a Judgment model on a stage", () => {
    const parsed = rules({
      routing: {
        stages: {
          steward: { models: { "claude-code": { complex: "fable" } } },
        },
      },
    });
    expect(parsed.reported).toEqual([
      "routing.stages.steward.models.claude-code.complex runs the complex tier on fable, a Judgment family no default names",
    ]);
  });

  it("gives a runtime with no default row only the cells a stage sets", () => {
    const row = parseRoutingModels(
      {
        routing: {
          stages: { steward: { models: { pi: { complex: "any/model" } } } },
        },
      },
      "steward",
    ).pi;
    expect(row).toEqual({ complex: "any/model" });
  });
});

describe("routing.family_tiers", () => {
  const OLD = {
    routing: {
      models: { codex: { complex: "gpt-house" } },
      family_tiers: {
        codex: {
          "gpt-house": { tier: "strategic", reason: "our gateway's flagship" },
        },
      },
    },
  };

  it("routes exactly as before", () => {
    const route = deriveRoute(facts(), rules(OLD));
    expect(route.model).toBe("gpt-house");
    expect(route.tier).toBe("complex");
    expect(rules(OLD).reported).toEqual([
      "routing.family_tiers.codex.gpt-house reads gpt-house as a strategic family: our gateway's flagship",
    ]);
  });

  it("is read as model_tiers entries, the two keys together", () => {
    const parsed = rules({
      routing: {
        models: { codex: { complex: "gpt-house" } },
        family_tiers: OLD.routing.family_tiers,
        model_tiers: {
          codex: { [OUTSIDE]: { tier: "strategic", reason: "new key" } },
        },
      },
    });
    expect(Object.keys(parsed.familyTiers.codex ?? {}).sort()).toEqual(
      ["gpt-house", OUTSIDE].sort(),
    );
  });

  it("refuses one model declared under both keys with different tiers", () => {
    expect(() =>
      rules({
        routing: {
          family_tiers: OLD.routing.family_tiers,
          model_tiers: {
            codex: { "gpt-house": { tier: "execution", reason: "disagrees" } },
          },
        },
      }),
    ).toThrow(/declare one model with different tiers/);
  });

  it("replaces every older-key spelling of one model and keeps each model_tiers spelling", () => {
    const parsed = rules({
      routing: {
        family_tiers: {
          codex: {
            sol: { tier: "strategic", reason: "old short" },
            "gpt-6.1-sol": { tier: "strategic", reason: "old legacy" },
          },
        },
        model_tiers: {
          codex: {
            "gpt-6.2-sol": { tier: "strategic", reason: "new release" },
            sol: { tier: "strategic", reason: "new short" },
          },
        },
      },
    });
    const row = parsed.familyTiers.codex ?? {};
    expect(Object.keys(row).sort()).toEqual(["gpt-6.2-sol", "sol"]);
    expect(row.sol?.reason).toBe("new short");
    expect(row["gpt-6.2-sol"]?.reason).toBe("new release");
    expect(parsed.reported).toHaveLength(2);
    expect(new Set(parsed.reported).size).toBe(2);
    expect([...parsed.reported].sort()).toEqual(
      [
        "routing.model_tiers.codex.sol reads sol as a strategic family: new short",
        'routing.model_tiers.codex."gpt-6.2-sol" reads "gpt-6.2-sol" as a strategic family: new release',
      ].sort(),
    );
    expect(parsed.reported.join("\n")).not.toMatch(/old short|old legacy/);
  });

  it("accepts one model declared under both keys with one tier", () => {
    const parsed = rules({
      routing: {
        models: { codex: { complex: "gpt-house" } },
        family_tiers: OLD.routing.family_tiers,
        model_tiers: {
          codex: { "gpt-house": { tier: "strategic", reason: "agrees" } },
        },
      },
    });
    expect(parsed.familyTiers.codex?.["gpt-house"]?.reason).toBe("agrees");
  });
});
