/**
 * The model families each runtime knows out of the box: the family alias a
 * route names, the model the alias names today, and the tier M0's mappings
 * give the family (modules/M0-instruction-architecture/mappings.md in the
 * Jig repository). This is the one place a release updates when a vendor
 * ships a new model under a family.
 *
 * A runtime that takes the alias itself (Claude Code resolves `sonnet` to
 * the latest Sonnet) is given the alias; one that takes only a model id
 * (Codex's `-m`) is given the model the alias names here.
 */

/** M0's model tiers, cheapest first. */
export const M0_TIERS = [
  "scout",
  "execution",
  "strategic",
  "judgment",
] as const;
export type M0Tier = (typeof M0_TIERS)[number];

export interface ModelFamily {
  /** The family alias a configuration names. */
  alias: string;
  /** The model the alias names today. */
  model: string;
  tier: M0Tier;
}

export interface RuntimeFamilies {
  /** Whether the runtime takes the alias as its model; else the family's model id. */
  takesAlias: boolean;
  families: readonly ModelFamily[];
}

export const MODEL_FAMILIES: Readonly<Record<string, RuntimeFamilies>> = {
  "claude-code": {
    takesAlias: true,
    families: [
      { alias: "haiku", model: "claude-haiku-5-5", tier: "scout" },
      { alias: "sonnet", model: "claude-sonnet-5-5", tier: "execution" },
      { alias: "opus", model: "claude-opus-5-5", tier: "strategic" },
      { alias: "fable", model: "claude-fable-5-1", tier: "judgment" },
    ],
  },
  codex: {
    takesAlias: false,
    families: [
      { alias: "luna", model: "gpt-6-luna", tier: "scout" },
      { alias: "terra", model: "gpt-5.6-terra", tier: "execution" },
      { alias: "sol", model: "gpt-6.1-sol", tier: "strategic" },
      { alias: "astra", model: "gpt-6-astra", tier: "judgment" },
    ],
  },
};

/** `runtime`'s known families, or `undefined` for a runtime with no list. */
export function familiesOf(runtime: string): RuntimeFamilies | undefined {
  return Object.hasOwn(MODEL_FAMILIES, runtime)
    ? MODEL_FAMILIES[runtime]
    : undefined;
}

/** The family `alias` names for `runtime`, or `undefined`. */
export function familyOf(
  runtime: string,
  alias: string,
): ModelFamily | undefined {
  return familiesOf(runtime)?.families.find((f) => f.alias === alias);
}

/**
 * The model `runtime` is given for `alias`: the alias itself where the
 * runtime takes aliases or has no list, else the model the alias names
 * today; a name outside the list passes as written.
 */
export function runtimeModel(runtime: string, alias: string): string {
  const known = familiesOf(runtime);
  if (known === undefined || known.takesAlias) return alias;
  return familyOf(runtime, alias)?.model ?? alias;
}
