import { at, type Finding } from "./schema.ts";

/** CI settings whose meaning depends on another repository policy field. */
export function ciPolicyFindings(config: Record<string, unknown>): Finding[] {
  const findings: Finding[] = [];
  const hold = at(config, "ci.hold_label");
  const checks = at(config, "ci.required_checks");
  if (typeof hold === "string" && !(Array.isArray(checks) && checks.length > 0))
    findings.push({
      id: "rule:ci.hold_label",
      severity: "error",
      message:
        "ci.hold_label needs a nonempty ci.required_checks: the drive certifies a held head only against declared checks",
    });
  const advisory = at(config, "ci.advisory_checks");
  const parkClasses = at(config, "autonomy.park_classes");
  if (
    Array.isArray(advisory) &&
    advisory.length > 0 &&
    Array.isArray(parkClasses) &&
    !parkClasses.includes("reviewer-posture")
  )
    findings.push({
      id: "rule:ci.advisory_checks",
      severity: "warning",
      message:
        "ci.advisory_checks has no effect because autonomy.park_classes omits reviewer-posture; allow that class to park on advisory-only CI failures",
    });
  return findings;
}
