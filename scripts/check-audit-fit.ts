// Scope: Jig's own audit record (.config/jig-audit.yaml) and configuration
// (.config/jig.yaml) against the audit skill in this checkout. A change that
// adds, renames or removes a maturity criterion fails here until Jig is scored
// against it, and a change to the configuration schema fails here until Jig's
// own configuration fits it, so the auditor is re-evaluated in the change that
// moves it. Stricter than the audit itself: the configuration file must exist,
// and a key Jig does not know inside one of its sections fails, since the
// skills would ignore it and a misspelt field keeps its default; a top-level
// section Jig does not own is left alone. Offline: the repository host and
// tracker are not read. Exit 1 on a mismatch; 2 when a file cannot be read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { configFit } from "../plugin/skills/audit/scripts/config-fit.ts";
import { loadModules } from "../plugin/skills/audit/scripts/lib/criteria.ts";
import { loadProfiles } from "../plugin/skills/audit/scripts/lib/profiles.ts";
import {
  checkRecord,
  parseRecord,
  RECORD_RELPATH,
} from "../plugin/skills/audit/scripts/lib/record.ts";

export async function checkAuditFit(
  root = ".",
  criteriaDir?: string,
): Promise<number> {
  const problems: string[] = [];
  try {
    const record = parseRecord(
      readFileSync(join(root, RECORD_RELPATH), "utf8"),
      RECORD_RELPATH,
    );
    const modules = loadModules(criteriaDir);
    // A test's own criteria have no profiles; the shipped ones always do.
    const profiles =
      criteriaDir === undefined ? loadProfiles(modules) : undefined;
    for (const p of checkRecord(record, modules, profiles))
      problems.push(`${RECORD_RELPATH}: ${p}`);
    const report = await configFit({
      root,
      file: join(root, ".config/jig.yaml"),
      offline: true,
      recordPath: join(root, RECORD_RELPATH),
    });
    if (!report.configured)
      problems.push(
        ".config/jig.yaml: missing; Jig's own configuration is required",
      );
    // A decline in the record does not exempt a finding the gate rejects.
    for (const f of [
      ...report.findings,
      ...report.declined.map((d) => d.finding),
    ])
      if (f.severity === "error" || /^unknown:[^.]+\./.test(f.id))
        problems.push(`.config/jig.yaml: config/${f.id}: ${f.message}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (problems.length === 0) return 0;
  for (const p of problems) console.error(p);
  console.error(
    "re-evaluate the audit for this change: score new criteria in .config/jig-audit.yaml, fix the configuration (plugin/skills/audit/SKILL.md)",
  );
  return 1;
}

if (import.meta.main) cli(() => checkAuditFit());
