// Scope: Jig's own audit record (.config/jig-audit.yaml) and configuration
// (.config/jig.yaml) against the audit skill in this checkout. A change that
// adds, renames or removes a maturity criterion fails here until Jig is scored
// against it, and a change to the configuration schema fails here until Jig's
// own configuration fits it, so the auditor is re-evaluated in the change that
// moves it. Stricter than the audit itself: the configuration file must exist,
// and a key Jig does not know inside one of its sections fails, since the
// skills would ignore it and a misspelt field keeps its default; a top-level
// section Jig does not own is left alone. The record's commit must be in the
// checkout's history: a record that names a branch commit a squash merge
// replaced fails on the integration branch, where it would otherwise rot
// until the next audit refused it. Offline: the repository host and
// tracker are not read. Exit 1 on a mismatch; 2 when a file cannot be read or
// there is no criterion to score against.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../plugin/shared/guarded-git-spawn.ts";
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
  let criteria = 0;
  try {
    const record = parseRecord(
      readFileSync(join(root, RECORD_RELPATH), "utf8"),
      RECORD_RELPATH,
    );
    const modules = loadModules(criteriaDir);
    criteria = modules.reduce((n, m) => n + m.criteria.length, 0);
    if (!criteria) throw new Error("no maturity criterion to score against");
    // A test's own criteria have no profiles; the shipped ones always do.
    const profiles =
      criteriaDir === undefined ? loadProfiles(modules) : undefined;
    for (const p of checkRecord(record, modules, profiles))
      problems.push(`${RECORD_RELPATH}: ${p}`);
    if (!inHistory(root, record.commit))
      problems.push(
        `${RECORD_RELPATH}: commit ${record.commit} is not in HEAD's history; point it at the integration-branch commit the audit scored`,
      );
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
  if (problems.length === 0) {
    console.log(
      `audit-fit: OK — ${RECORD_RELPATH} scores all ${criteria} criteria and .config/jig.yaml fits the audit's schema (offline: the host and the tracker are not read; whether a score is right is the audit's question, not this check's)`,
    );
    return 0;
  }
  for (const p of problems) console.error(p);
  console.error(
    "re-evaluate the audit for this change: score new criteria in .config/jig-audit.yaml, fix the configuration (plugin/skills/audit/SKILL.md)",
  );
  return 1;
}

/** Whether `commit` is HEAD or one of its ancestors in the checkout at `root`. */
function inHistory(root: string, commit: string): boolean {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
    ),
  );
  const result = spawnSync(
    "git",
    ["-C", root, "merge-base", "--is-ancestor", commit, "HEAD"],
    { env },
  );
  return result.status === 0;
}

if (import.meta.main) cli(() => checkAuditFit());
