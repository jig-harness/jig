/** The repository's failed-check retry policy, read through the shared configuration layers. */
import { readConfig, configSource } from "../../../../../shared/consumer.ts";
import { readPolicySnapshot } from "../../../../../shared/autonomy.ts";
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

/** A running drive takes retry authority from reviewed policy, never its PR. */
export function reviewedRerunFailedOnceSetting(): Outcome<
  boolean,
  "invalid-config"
> {
  const policy = readPolicySnapshot();
  if (policy.from === "unreadable")
    return failed(
      "invalid-config",
      `CI retry policy unreadable: ${policy.reason}`,
    );
  const setting = rerunFailedOnceSetting(
    policy.from === "base" ? policy.values : readConfig(),
  );
  if (!setting.ok || policy.from !== "base" || policy.bound === undefined)
    return setting;
  const bound = rerunFailedOnceSetting(policy.bound.values);
  if (!bound.ok) return bound;
  // A stacked branch may narrow an automation permission but cannot widen it.
  return ok(setting.value && bound.value);
}
