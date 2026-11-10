/**
 * The model a drive's passes run on.
 *
 * A pass is one round's agent process. When it is Claude Code's CLI
 * (`claude`, a documented pass command), the driver decides its model, in
 * this order:
 *
 *   1. `--pass-model` on `drive.ts`, for one run: it replaces the pass
 *      command's own `--model`, or is added after `claude`;
 *   2. the pass command's own `--model`, kept as written (the arm command
 *      `arm-drive.ts` builds carries the configured model there, and the
 *      driver log then names the setting it came from); an own `--model`
 *      that names no model (empty, or not one word) is reported as none;
 *   3. `drive.pass_model`, else `sonnet`, added after `claude`.
 *
 * A value is a model id, a Claude Code alias (`sonnet` follows the latest
 * Sonnet) or a complexity tier (`simple`, `standard`, `complex`; the legacy
 * `execution` and `strategic` read as `standard` and `complex`), which
 * resolves through the same tier-to-model table as the implementer's route
 * (`routing.models.claude-code`).
 *
 * When it is Codex's (`codex`, the other documented pass command,
 * `pass-command.ts`), the model is the pass command's own (`-m`, `--model`),
 * else the standard tier of `routing.models.codex` (by default `terra`),
 * given as the model the family names today (`plugin/shared/model-families.ts`)
 * and added after `exec`. A family alias Codex knows, named by
 * `--pass-model` or a tier, is given as its model too. `drive.pass_model` and
 * `--pass-model` differ: the setting is Claude Code's, while the flag
 * overrides either vendor and resolves tiers through that vendor's row.
 *
 * Only the model option is read or written: the rest of the pass command
 * stays as the caller gave it, and a pass command of any other tool (a
 * wrapper, a shell) chooses its own model, so `--pass-model` is refused for
 * it rather than guessed into its grammar.
 */
import { basename } from "node:path";
import { swallow } from "../../../../shared/errors.ts";
import { runtimeModel } from "../../../../shared/model-families.ts";
import {
  parseRoutingModels,
  RoutingError,
  tierNamed,
} from "../../../do-item/scripts/lib/routing.ts";
import { passVendor } from "./identity.ts";
import {
  DEFAULT_PASS_MODEL,
  PASS_MODEL_PATTERN,
  passModelSetting,
  readOptionalOverlay,
} from "./overlay.ts";

/** The runtime whose row of `routing.models` a pass's tier resolves through. */
const PASS_RUNTIME = "claude-code";

/** The runtime row, and its tier, a Codex pass's model comes from. */
const CODEX_RUNTIME = "codex";
const CODEX_TIER = "standard";

/** A pass model and where it came from, for the driver log. */
export interface PassModel {
  model: string;
  source: string;
}

/** A `--pass-model` value the driver cannot use: a usage error (exit 2). */
export class PassModelUsageError extends Error {}

/**
 * The model `value` names: a complexity tier resolved through the selected
 * runtime's `routing.models` row, anything else as written, each given as
 * the model the runtime takes for it (Codex's model id for a family alias).
 * `where` names the value's origin in the source and in errors.
 */
export function resolveModelValue(
  value: string,
  where: string,
  overlay: () => Record<string, unknown> = readOptionalOverlay,
  runtime = PASS_RUNTIME,
): PassModel {
  if (!PASS_MODEL_PATTERN.test(value))
    throw new PassModelUsageError(
      `${where} must be one word naming a model, a Claude Code alias or a complexity tier (got '${value}')`,
    );
  const tier = tierNamed(value);
  if (tier === undefined) {
    const model = runtimeModel(runtime, value);
    return {
      model,
      source: model === value ? where : `${where}: the model ${value} names`,
    };
  }
  const alias = parseRoutingModels(overlay())[runtime]?.[tier];
  if (alias === undefined)
    throw new RoutingError(
      `${where} names the ${tier} tier, but routing.models has no ${runtime} row to resolve it through`,
    );
  const named =
    value === tier ? `the ${tier} tier` : `the ${tier} tier (${value})`;
  const model = runtimeModel(runtime, alias);
  return {
    model,
    source: `${where}: ${named}, routing.models.${runtime}.${tier}${model === alias ? "" : ` (${alias})`}`,
  };
}

/** The model the configuration asks for: `drive.pass_model`, else `sonnet`. */
export function configuredPassModel(): PassModel {
  const value = passModelSetting();
  if (value === undefined)
    return {
      model: DEFAULT_PASS_MODEL,
      source: "the default; drive.pass_model is not set",
    };
  return resolveModelValue(value, "drive.pass_model");
}

/** A Codex pass's model as the configuration asks for it; `model` is `null` when Codex's own configuration decides. */
export interface CodexPassModel {
  model: string | null;
  source: string;
}

/**
 * The model the configuration asks for a Codex pass: the standard tier of
 * `routing.models.codex`, its default included, given as the model the
 * family names; none only where no row names one.
 */
export function configuredCodexModel(
  overlay: () => Record<string, unknown> = readOptionalOverlay,
): CodexPassModel {
  const alias = parseRoutingModels(overlay())[CODEX_RUNTIME]?.[CODEX_TIER];
  if (alias === undefined)
    return {
      model: null,
      source: `Codex's own configuration; routing.models.${CODEX_RUNTIME} names no ${CODEX_TIER} model`,
    };
  const model = runtimeModel(CODEX_RUNTIME, alias);
  return {
    model,
    source: `routing.models.${CODEX_RUNTIME}.${CODEX_TIER}${model === alias ? "" : ` (${alias})`}`,
  };
}

/** The words that take the model as the next word: `--model` for both tools, and Codex's `-m`. */
function modelFlags(argv: readonly string[]): ReadonlySet<string> {
  return passVendor(argv) === "codex"
    ? new Set(["--model", "-m"])
    : new Set(["--model"]);
}

/** Where the model option sits in a `claude` or `codex` argv, and its value. */
function modelOption(
  argv: readonly string[],
): { index: number; width: 1 | 2; value: string } | null {
  const flags = modelFlags(argv);
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i] as string;
    if (word === "--") break;
    if (flags.has(word) && i + 1 < argv.length)
      return { index: i, width: 2, value: argv[i + 1] as string };
    if (word.startsWith("--model="))
      return { index: i, width: 1, value: word.slice("--model=".length) };
    if (flags.has("-m") && word.startsWith("-m") && word.length > 2)
      return { index: i, width: 1, value: word.slice(word[2] === "=" ? 3 : 2) };
  }
  return null;
}

/**
 * `argv` without a `claude` or `codex` pass's model option, so a check that
 * reads the PR number out of the pass command does not read it out of a
 * model id.
 */
export function withoutModel(argv: readonly string[]): string[] {
  if (passVendor(argv) === null) return [...argv];
  let rest = [...argv];
  for (let own = modelOption(rest); own !== null; own = modelOption(rest))
    rest = [...rest.slice(0, own.index), ...rest.slice(own.index + own.width)];
  return rest;
}

/**
 * `argv` with its `--model` set to `model`: every own `--model` removed and
 * one put where the first was, else added after `claude`.
 */
function withModel(argv: readonly string[], model: string): string[] {
  const rest = withoutModel(argv);
  const at = modelOption(argv)?.index ?? 1;
  return [...rest.slice(0, at), "--model", model, ...rest.slice(at)];
}

/** Replace a Codex pass's model with `-m model` after `exec` (after `codex` when it has none). */
export function withCodexModel(
  argv: readonly string[],
  model: string,
): string[] {
  const rest = withoutModel(argv);
  const at = rest[1] === "exec" ? 2 : 1;
  return [...rest.slice(0, at), "-m", model, ...rest.slice(at)];
}

/** The pass command the driver runs, and the model it runs on. */
export interface EffectivePass {
  argv: string[];
  /** `null` when the pass command chooses its own model. */
  model: string | null;
  source: string;
}

/** The driver log's line naming the pass model and where it came from. */
export function passModelLine(pass: EffectivePass): string {
  return pass.model === null
    ? `pass model: ${pass.source}`
    : `pass model: ${pass.model} (${pass.source})`;
}

/** The configured model, or `null` when the configuration cannot say. */
function configuredOrNull(configured: () => PassModel): PassModel | null {
  try {
    return configured();
  } catch (error) {
    swallow(error, "the configured pass model only names a source here");
    return null;
  }
}

/**
 * A pass command's own `--model`: the model it names, with the setting it
 * came from when the configuration resolves to the same model; none when the
 * value names no model.
 */
function ownModel(
  argv: readonly string[],
  value: string,
  configured: () => PassModel,
): EffectivePass {
  if (!PASS_MODEL_PATTERN.test(value))
    return {
      argv: [...argv],
      model: null,
      source: `the pass command's own --model '${value}', which names no model`,
    };
  const config = configuredOrNull(configured);
  return {
    argv: [...argv],
    model: value,
    source:
      config?.model === value
        ? `${config.source}, as the pass command's --model`
        : "the pass command's own --model",
  };
}

/**
 * A Codex pass command with its model decided: its own, else the
 * configured one, else none.
 */
function codexPass(
  argv: readonly string[],
  configured: () => CodexPassModel,
): EffectivePass {
  const own = modelOption(argv);
  if (own !== null) {
    if (!PASS_MODEL_PATTERN.test(own.value))
      return {
        argv: [...argv],
        model: null,
        source: `the pass command's own model '${own.value}', which names no model`,
      };
    let config: CodexPassModel | null = null;
    try {
      config = configured();
    } catch (error) {
      swallow(error, "the configured Codex model only names a source here");
    }
    return {
      argv: [...argv],
      model: own.value,
      source:
        config?.model === own.value
          ? `${config.source}, as the pass command's -m`
          : "the pass command's own model",
    };
  }
  const chosen = configured();
  return chosen.model === null
    ? { argv: [...argv], model: null, source: chosen.source }
    : {
        argv: withCodexModel(argv, chosen.model),
        model: chosen.model,
        source: chosen.source,
      };
}

/**
 * The pass command with its model decided (see the module header), from the
 * command as given, the `--pass-model` flag and the configured model.
 */
export function effectivePass(
  argv: readonly string[],
  flag: string | undefined,
  configured: () => PassModel = configuredPassModel,
  codex: () => CodexPassModel = configuredCodexModel,
): EffectivePass {
  const first = argv[0];
  if (first === undefined)
    return { argv: [], model: null, source: "no pass command given" };
  const vendor = passVendor(argv);
  if (vendor === null && flag !== undefined)
    throw new PassModelUsageError(
      `--pass-model applies to a Claude Code pass command or a Codex pass command; '${basename(first)}' chooses its own model`,
    );
  if (vendor === "codex") {
    if (flag === undefined) return codexPass(argv, codex);
    const chosen = resolveModelValue(
      flag,
      "--pass-model",
      readOptionalOverlay,
      CODEX_RUNTIME,
    );
    return { argv: withCodexModel(argv, chosen.model), ...chosen };
  }
  if (vendor !== "claude")
    return {
      argv: [...argv],
      model: null,
      source: `chosen by the pass command (${basename(first)})`,
    };
  const own = modelOption(argv);
  if (flag !== undefined) {
    const chosen = resolveModelValue(flag, "--pass-model");
    const replaced = own === null || own.value === chosen.model ? null : own;
    return {
      argv: withModel(argv, chosen.model),
      model: chosen.model,
      source:
        replaced === null
          ? chosen.source
          : `${chosen.source}, replacing the pass command's --model ${replaced.value}`,
    };
  }
  if (own !== null) return ownModel(argv, own.value, configured);
  const chosen = configured();
  return {
    argv: withModel(argv, chosen.model),
    model: chosen.model,
    source: chosen.source,
  };
}
