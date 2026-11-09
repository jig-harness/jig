/**
 * determine_route.ts: the complexity tier from the type, the size and the
 * complex flags, and the model each tier runs on per runtime, with the
 * loader's checks against the known families.
 */

import { describe, expect, it } from "bun:test";
import { deriveRoute, type RouteFacts } from "../scripts/determine_route.ts";
import { parseRouting } from "../scripts/lib/routing.ts";
import { parseWorkTypes } from "../scripts/lib/work-types.ts";

const facts = (over: Partial<RouteFacts> = {}): RouteFacts => ({
  agent: "general-purpose",
  type: "bug",
  labels: [],
  catalog: { flags: [], reviews: [] },
  hitl: "hitl",
  knownSizes: ["xs", "small", "medium"],
  batchSizes: ["xs", "small", "medium"],
  runtime: "claude-code",
  ...over,
});

const rules = (config: Record<string, unknown> = {}) =>
  parseRouting(config, parseWorkTypes(config));

const route = (
  over: Partial<RouteFacts> = {},
  config: Record<string, unknown> = { routing: {} },
) => deriveRoute(facts(over), rules(config));

describe("the complexity tiers", () => {
  const SIZES = ["xs", "small", "medium", "large", "xl"];
  const sized = (type: string, size: string | null) =>
    route({ type, knownSizes: SIZES, sizes: size === null ? [] : [size] });

  it.each([
    ["bug", "xs", "standard"],
    ["bug", "medium", "standard"],
    ["bug", "large", "complex"],
    ["improvement", "small", "standard"],
    ["feature", "medium", "standard"],
    ["feature", "xl", "complex"],
    ["task", "xs", "simple"],
    ["task", "large", "simple"],
    ["task", "xl", "standard"],
    ["spike", "xs", "complex"],
  ])("routes a %s of size %s %s", (type, size, tier) => {
    const r = sized(type, size);
    expect<string>(r.tier).toBe(tier);
  });

  it("routes an S bug standard, and the same bug labelled has-migration complex", () => {
    const plain = route({ type: "bug", labels: ["small"] });
    expect(plain.tier).toBe("standard");
    expect(plain.size).toBe("S");
    expect(plain.reasons).toContain("tier: standard (type bug, size S)");
    const flagged = route({ type: "bug", labels: ["small", "has-migration"] });
    expect(flagged.tier).toBe("complex");
    expect(flagged.reasons).toContain("tier: complex (flag has-migration)");
  });

  it("reads an unknown size as M", () => {
    expect(sized("feature", null).reasons).toContain(
      "tier: standard (type feature, no size, read as M)",
    );
    expect(sized("task", "huge").reasons).toContain(
      "tier: simple (type task, size huge, not one the table knows, read as M)",
    );
  });

  it("reads a size label kept under a prefix", () => {
    expect(route({ type: "bug", labels: ["size:L"] }).tier).toBe("complex");
  });

  it("sets complex from a flag an area the item seeds declares", () => {
    const r = route({
      type: "task",
      catalog: {
        flags: ["api-change"],
        reviews: [],
        seededFlags: ["api-change"],
      },
    });
    expect(r.tier).toBe("complex");
    expect(r.reasons).toContain(
      "tier: complex (flag api-change of an area it seeds)",
    );
  });

  it("reads routing.complex_flags in place of the defaults", () => {
    const config = { routing: { complex_flags: ["security"] } };
    expect(route({ labels: ["security"] }, config).tier).toBe("complex");
    expect(route({ labels: ["has-migration"] }, config).tier).toBe("standard");
    expect(
      route({ labels: ["has-migration"] }, { routing: { complex_flags: [] } })
        .tier,
    ).toBe("standard");
  });

  it("takes a type row's own tier over the table, a complex flag still setting complex", () => {
    const config = { routing: { types: { bug: { tier: "simple" } } } };
    const r = route({ type: "bug", labels: ["large"] }, config);
    expect(r.tier).toBe("simple");
    expect(r.reasons).toContain("tier: simple (routing.types.bug.tier)");
    expect(route({ labels: ["api-change"] }, config).tier).toBe("complex");
  });

  it("reads the legacy tier names as standard and complex", () => {
    const config = {
      routing: {
        types: { bug: { tier: "strategic", effort: "high" } },
        models: { "claude-code": { execution: "sonnet", strategic: "opus" } },
      },
    };
    const r = route({ type: "bug", labels: ["small"] }, config);
    expect({ tier: r.tier, effort: r.effort, model: r.model }).toEqual({
      tier: "complex",
      effort: "high",
      model: "opus",
    });
    expect(
      route(
        { type: "task" },
        { routing: { types: { task: { tier: "execution" } } } },
      ).tier,
    ).toBe("standard");
  });

  it("never writes a model or a tier onto the issue: the route is printed, never a label", () => {
    const r = route({ type: "bug", labels: ["has-migration"] });
    expect(Object.keys(r).sort()).toEqual(
      [
        "agent",
        "declared",
        "effort",
        "fields",
        "model",
        "reasons",
        "runtime",
        "runtime_effort",
        "runtime_model",
        "size",
        "tier",
        "type",
      ].sort(),
    );
  });
});

describe("the models per tier", () => {
  const models = (routing: Record<string, unknown>) =>
    rules({ routing }).models;

  it("defaults both Claude Code and Codex", () => {
    expect(models({})).toEqual({
      "claude-code": { simple: "sonnet", standard: "sonnet", complex: "opus" },
      codex: { simple: "terra", standard: "terra", complex: "sol" },
    });
  });

  it("keeps a small task on opus where the legacy row names opus for both tiers", () => {
    const config = {
      routing: {
        models: { "claude-code": { execution: "opus", strategic: "opus" } },
      },
    };
    expect(models(config.routing)["claude-code"]).toEqual({
      simple: "opus",
      standard: "opus",
      complex: "opus",
    });
    expect(route({ type: "task", labels: ["xs"] }, config).model).toBe("opus");
  });

  it("keeps a custom runtime's legacy execution model for simple and standard", () => {
    expect(
      models({ models: { custom: { execution: "a", strategic: "b" } } }).custom,
    ).toEqual({
      simple: "a",
      standard: "a",
      complex: "b",
    });
  });

  it("lets an explicit simple model replace the legacy fallback", () => {
    expect(
      models({
        models: { custom: { simple: "z", execution: "a", strategic: "b" } },
      }).custom,
    ).toEqual({ simple: "z", standard: "a", complex: "b" });
  });

  it("fills a tier a row leaves out from the runtime's default", () => {
    expect(models({ models: { codex: { complex: "astra" } } }).codex).toEqual({
      simple: "terra",
      standard: "terra",
      complex: "astra",
    });
  });

  it("coalesces a legacy and a new key naming the same model, and refuses two that differ", () => {
    expect(
      models({
        models: { "claude-code": { execution: "sonnet", standard: "sonnet" } },
      })["claude-code"]?.standard,
    ).toBe("sonnet");
    expect(() =>
      models({
        models: { "claude-code": { strategic: "opus", complex: "fable" } },
      }),
    ).toThrow(
      "routing.models.claude-code.strategic (opus) and routing.models.claude-code.complex (fable) both name the complex tier's model",
    );
  });

  it.each([
    ["claude-code", "haiku"],
    ["codex", "luna"],
  ])("refuses a %s tier mapped to the Scout family %s", (runtime, scout) => {
    for (const tier of ["simple", "standard", "complex", "execution"])
      expect(() =>
        models({ models: { [runtime]: { [tier]: scout } } }),
      ).toThrow(`${scout} is a Scout family`);
  });

  it("refuses a Scout family whatever routing.family_tiers says", () => {
    expect(() =>
      models({
        models: { "claude-code": { simple: "haiku" } },
        family_tiers: {
          "claude-code": {
            haiku: { tier: "execution", reason: "ours is larger" },
          },
        },
      }),
    ).toThrow("no routing.family_tiers entry changes that");
  });

  it("runs a complex item on Fable where a repository configures it, and reports it", () => {
    const config = {
      routing: { models: { "claude-code": { complex: "fable" } } },
    };
    expect(route({ type: "spike" }, config).model).toBe("fable");
    expect(rules(config).reported).toEqual([
      "routing.models.claude-code.complex runs the complex tier on fable, a Judgment family no default names",
    ]);
    expect(rules({ routing: {} }).reported).toEqual([]);
  });

  it("refuses an alias outside a runtime's known families", () => {
    expect(() =>
      models({ models: { codex: { standard: "gpt-example" } } }),
    ).toThrow(
      "routing.models.codex.standard: gpt-example is not a model family codex knows (luna, terra, sol, astra)",
    );
  });

  it("refuses a stricter tier on a family of a lower M0 tier", () => {
    expect(() =>
      models({
        models: { "claude-code": { standard: "opus", complex: "sonnet" } },
      }),
    ).toThrow(
      "routing.models.claude-code.complex: the complex tier runs on sonnet (M0 execution), a lower M0 tier than the standard tier's opus (M0 strategic)",
    );
  });

  it("accepts a family a repository declares, with its reason, and reports it", () => {
    const r = rules({
      routing: {
        models: { codex: { complex: "gpt-house" } },
        family_tiers: {
          codex: {
            "gpt-house": {
              tier: "strategic",
              reason: "our gateway's flagship",
            },
          },
        },
      },
    });
    expect(r.models.codex?.complex).toBe("gpt-house");
    expect(r.reported).toContain(
      "routing.family_tiers.codex.gpt-house reads gpt-house as a strategic family: our gateway's flagship",
    );
  });

  it("refuses a family_tiers entry with no reason", () => {
    expect(() =>
      models({ family_tiers: { codex: { terra: { tier: "strategic" } } } }),
    ).toThrow("routing.family_tiers.codex.terra.reason must say why");
  });
});
