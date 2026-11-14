/**
 * What the configuration layers of the machine running the audit add: the
 * audit judges the repository's file alone, but the skills on this machine,
 * and `trackerCheck`, also read the user file and the environment.
 */
import {
  ENV_PREFIX,
  isMapping as isRecord,
  readConfigFile,
  userConfigPath,
  userLayerEnabled,
} from "../../../../shared/config-layers.ts";
import { codexPassArgsProblem } from "../../../drive-pr/scripts/lib/codex-pass-args.ts";
import { passArgsProblem } from "../../../drive-pr/scripts/lib/overlay.ts";
import { at, type Finding, type Schema } from "./schema.ts";

type Config = Record<string, unknown>;

/** The dotted paths of every value set in `config`. */
function leafFields(config: Config, prefix = ""): string[] {
  return Object.entries(config).flatMap(([key, value]) =>
    isRecord(value)
      ? leafFields(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

/** Each host setting a drive reads from the user file, and why a value cannot be it. */
const HOST_SETTINGS: ReadonlyArray<
  [string, (value: unknown) => string | undefined]
> = [
  ["drive.pass_args", passArgsProblem],
  ["drive.codex_pass_args", codexPassArgsProblem],
  [
    "drive.codex_bypass",
    (value) =>
      typeof value === "boolean" ? undefined : "must be true or false",
  ],
];

/** What is wrong with the host's own settings in its user file: a drive here stops on either. */
function hostSettingProblems(user: Config): string[] {
  const drive = user.drive;
  if (drive !== undefined && drive !== null && !isRecord(drive))
    return ["drive must be an object"];
  return HOST_SETTINGS.flatMap(([field, problem]) => {
    const value = at(user, field);
    const wrong =
      value === undefined || value === null ? undefined : problem(value);
    return wrong === undefined ? [] : [`${field} ${wrong}`];
  });
}

/**
 * The facts about this machine's layers: a user file that cannot be read,
 * that sets a field only a repository may, or that holds a host setting a
 * drive stops on, and what the user file and the environment add.
 */
export function machineLayers(config: Config, schema: Schema): Finding[] {
  const findings: Finding[] = [];
  const path = userConfigPath();
  let user: Config | null = null;
  try {
    user = userLayerEnabled() ? readConfigFile(path) : null;
  } catch (error) {
    findings.push({
      id: "fact:user-layer-unreadable",
      severity: "warning",
      message: `this machine's user file cannot be read, so every skill here refuses to run: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const refused = schema.fields
    .filter((f) => f.repository_only && user && at(user, f.path) !== undefined)
    .map((f) => f.path);
  if (refused.length > 0)
    findings.push({
      id: "fact:user-layer-refused",
      severity: "warning",
      message: `this machine's ${path} sets ${refused.join(", ")}, which describe one repository: every skill here refuses the file until they move to the repository's file`,
    });
  for (const problem of user === null ? [] : hostSettingProblems(user))
    findings.push({
      id: "fact:user-layer-invalid",
      severity: "warning",
      message: `this machine's ${path}: ${problem}, and a drive here stops on it`,
    });
  const repository = new Set(leafFields(config));
  const filled = user ? leafFields(user).filter((f) => !repository.has(f)) : [];
  if (filled.length > 0)
    findings.push({
      id: "fact:user-layer",
      severity: "info",
      message: `on this machine ${path} sets ${filled.join(", ")}, which the repository's file leaves unset: the skills here use those values, others get the defaults. The audit judged the repository's file alone, except for the tracker check, which reads the configuration as the skills here do`,
    });
  const variables = Object.keys(process.env).filter((k) =>
    k.startsWith(ENV_PREFIX),
  );
  if (variables.length > 0)
    findings.push({
      id: "fact:environment-layer",
      severity: "info",
      message: `${variables.join(", ")} set values for this run only; the audit ignored them, except for the tracker check, which reads the configuration as the skills here do`,
    });
  return findings;
}
