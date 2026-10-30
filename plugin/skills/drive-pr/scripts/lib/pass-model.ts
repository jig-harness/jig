/**
 * The model a drive's passes run on.
 *
 * A pass is one round's agent process. When it is Claude Code's CLI
 * (`claude`, the documented pass command), the driver decides its model, in
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
 * Sonnet) or a routing tier (`execution`, `strategic`), which resolves through
 * the same tier-to-model table as the implementer's route
 * (`routing.models.claude-code`). Only `--model` is read or written: the rest
 * of the pass command stays as the caller gave it, and a pass command that is
 * not `claude` (another agent tool, a wrapper) chooses its own model, so
 * `--pass-model` is refused for it rather than guessed into its grammar.
 */
import { basename } from "node:path";
import { swallow } from "../../../../shared/errors.ts";
import {
  parseRoutingModels,
  RoutingError,
  TIERS,
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

/** A pass model and where it came from, for the driver log. */
export interface PassModel {
  model: string;
  source: string;
}

/** A `--pass-model` value the driver cannot use: a usage error (exit 2). */
export class PassModelUsageError extends Error {}

/**
 * The model `value` names: a routing tier resolved through
 * `routing.models.claude-code`, anything else as written. `where` names the
 * value's origin in the source and in errors.
 */
export function resolveModelValue(
  value: string,
  where: string,
  overlay: () => Record<string, unknown> = readOptionalOverlay,
): PassModel {
  if (!PASS_MODEL_PATTERN.test(value))
    throw new PassModelUsageError(
      `${where} must be one word naming a model, a Claude Code alias or a routing tier (got '${value}')`,
    );
  const tier = TIERS.find((t) => t === value);
  if (tier === undefined) return { model: value, source: where };
  const model = parseRoutingModels(overlay())[PASS_RUNTIME]?.[tier];
  if (model === undefined)
    throw new RoutingError(
      `${where} names the ${tier} tier, but routing.models has no ${PASS_RUNTIME} row to resolve it through`,
    );
  return {
    model,
    source: `${where}: the ${tier} tier, routing.models.${PASS_RUNTIME}.${tier}`,
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

/** Where `--model` sits in a `claude` argv, and its value. */
function modelOption(
  argv: readonly string[],
): { index: number; width: 1 | 2; value: string } | null {
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i] as string;
    if (word === "--model" && i + 1 < argv.length)
      return { index: i, width: 2, value: argv[i + 1] as string };
    if (word.startsWith("--model="))
      return { index: i, width: 1, value: word.slice("--model=".length) };
  }
  return null;
}

/**
 * `argv` without a `claude` pass's `--model` option, so a check that reads
 * the PR number out of the pass command does not read it out of a model id.
 */
export function withoutModel(argv: readonly string[]): string[] {
  if (passVendor(argv) !== "claude") return [...argv];
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
 * The pass command with its model decided (see the module header), from the
 * command as given, the `--pass-model` flag and the configured model.
 */
export function effectivePass(
  argv: readonly string[],
  flag: string | undefined,
  configured: () => PassModel = configuredPassModel,
): EffectivePass {
  const first = argv[0];
  if (first === undefined)
    return { argv: [], model: null, source: "no pass command given" };
  if (passVendor(argv) !== "claude") {
    if (flag !== undefined)
      throw new PassModelUsageError(
        `--pass-model applies to a Claude Code pass command (claude …); '${basename(first)}' chooses its own model`,
      );
    return {
      argv: [...argv],
      model: null,
      source: `chosen by the pass command (${basename(first)})`,
    };
  }
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
