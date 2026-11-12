// Scope: the nightly run's known-failure baseline,
// `.config/nightly-baseline.yaml` (scripts/nightly/baseline.ts). Each group
// names a platform, the issue that owns the fix as `#<number>`, and a
// reason; no test is recorded twice for one platform; every recorded file
// exists, and every recorded test can still be found in it
// (scripts/nightly/titles.ts), so an entry for a test that was renamed,
// moved or removed is caught here rather than left to excuse nothing. Exit 1
// for a finding, 2 when the baseline cannot be read.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../lib/findings.ts";
import { readBaseline } from "./nightly/baseline.ts";
import { TitleIndex } from "./nightly/titles.ts";

export const BASELINE_FILE = ".config/nightly-baseline.yaml";
const RULE = "nightly-baseline";

export function checkNightlyBaseline(root = "."): number {
  let raw: string;
  try {
    raw = readFileSync(join(root, BASELINE_FILE), "utf8");
  } catch (error) {
    return couldNotCheck(RULE, `${BASELINE_FILE}: ${String(error)}`);
  }
  const { entries, problems } = readBaseline(raw);
  const findings: Finding[] = problems.map(({ where, problem }) => ({
    rule: RULE,
    file: BASELINE_FILE,
    problem: `${where}: ${problem}`,
    remedy: `follow the format ${BASELINE_FILE}'s header describes`,
  }));
  const titles = new TitleIndex(root);
  for (const { platform, file, name } of entries) {
    const path = join(root, file);
    const present = existsSync(path) && statSync(path).isFile();
    if (present && titles.has(file, name)) continue;
    findings.push({
      rule: RULE,
      file: BASELINE_FILE,
      problem: present
        ? `${platform}: ${file} no longer declares ${JSON.stringify(name)}`
        : `${platform}: ${file} does not exist`,
      remedy:
        "remove the entry, or rename it to the test's current name; a test that now passes needs no entry",
    });
  }
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `nightly-baseline: OK — ${entries.length} recorded failure(s), each naming a test that exists`,
  );
  return 0;
}

if (import.meta.main) cli(() => checkNightlyBaseline(process.argv[2]));
