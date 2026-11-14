/** The repository's failed-check retry policy, read through the shared configuration layers. */
import { readConfig, configSource } from "../../../../../shared/consumer.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../../../../shared/outcome.ts";

export function rerunFailedOnceSetting(
  config: Record<string, unknown> = readConfig(),
): Outcome<boolean, "invalid-config"> {
  const ci = config.ci;
  if (ci === undefined || ci === null) return ok(true);
  if (!isRecord(ci))
    return failed(
      "invalid-config",
      `ci must be a mapping: ${configSource("ci")}`,
    );
  const value = ci.rerun_failed_once;
  if (value === undefined || value === null) return ok(true);
  return typeof value === "boolean"
    ? ok(value)
    : failed(
        "invalid-config",
        `ci.rerun_failed_once must be a boolean: ${configSource("ci.rerun_failed_once")}`,
      );
}
