/**
 * The known model families: each runtime's aliases with their M0 tier, and
 * the model a runtime is given for an alias.
 */
import { describe, expect, it } from "bun:test";
import {
  familiesOf,
  familyOf,
  M0_TIERS,
  runtimeModel,
} from "../model-families.ts";

describe("the known families", () => {
  it.each([
    ["claude-code", ["haiku", "sonnet", "opus", "fable"]],
    ["codex", ["luna", "terra", "sol", "astra"]],
  ])(
    "lists %s's families, one per M0 tier, cheapest first",
    (runtime, aliases) => {
      const known = familiesOf(runtime)?.families ?? [];
      expect(known.map((f) => f.alias)).toEqual(aliases);
      expect(known.map((f) => f.tier)).toEqual([...M0_TIERS]);
    },
  );

  it("names OpenAI's models by their ids", () => {
    expect(familyOf("codex", "luna")?.model).toBe("gpt-6-luna");
    expect(familyOf("codex", "terra")?.model).toBe("gpt-5.6-terra");
    expect(familyOf("codex", "sol")?.model).toBe("gpt-6.1-sol");
    expect(familyOf("codex", "astra")?.model).toBe("gpt-6-astra");
  });

  it("has no list for another runtime", () => {
    expect(familiesOf("other")).toBeUndefined();
    expect(familiesOf("toString")).toBeUndefined();
  });
});

describe("runtimeModel", () => {
  it("gives Claude Code the alias and Codex the model id", () => {
    expect(runtimeModel("claude-code", "opus")).toBe("opus");
    expect(runtimeModel("codex", "sol")).toBe("gpt-6.1-sol");
  });

  it("passes a name outside the list, or a runtime with none, as written", () => {
    expect(runtimeModel("codex", "gpt-house")).toBe("gpt-house");
    expect(runtimeModel("other", "terra")).toBe("terra");
  });
});
