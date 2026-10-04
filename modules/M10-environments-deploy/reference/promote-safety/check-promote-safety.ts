#!/usr/bin/env bun
// Promote-safety lint: a production deploy path must be gated and verified.
//
// The problem it catches. "Deploy only verified artifacts, and only on a human's
// say-so" is a promise the deploy WORKFLOW has to keep. Two wiring mistakes break
// it silently:
//   (a) the production deploy fires automatically on a branch push, with no
//       manual gate or environment approval — so any merge ships to prod, and a
//       bad merge reaches users before anyone looks; and
//   (b) the production deploy ships a MUTABLE ref (a moving branch, HEAD, an
//       `:latest` image) instead of the pinned `verified` pointer/artifact — so
//       what reaches prod is whatever the branch happens to be, not the thing
//       that actually passed verification.
// This lint scans a workflows directory and fails a production-deploy workflow
// that commits either mistake, so the safe wiring can't quietly regress.
//
// Scoped to the DEPLOY JOB, not the file. A workflow has many jobs; the checks
// apply to the job that actually deploys to production, so a gate or a
// `verified` reference on some OTHER job (a preview deploy with its own
// environment, a build job that checks out the verified ref) can't mask an
// unsafe production job. The lint segments the workflow into jobs (GitHub
// Actions `jobs:` children; GitLab top-level jobs) and evaluates each
// production-deploy job — one that carries BOTH a deploy signal (`deploy`) and a
// production signal (`prod`/`production`) — on its own.
//
// What trips it — a production-deploy JOB where:
//   (a) it fires on `push` — a GitHub Actions `on: push` (bare or quoted scalar,
//       flow sequence [push], a block-sequence item `- push`, block `push:`, or
//       an inline `on: { push: ... }` mapping), or a GitLab push rule
//       (`$CI_PIPELINE_SOURCE == "push"`, or legacy `only: pushes`), including a
//       rule inside the job — AND that job has no gate on the push run: no
//       `environment:` key (where GitHub/GitLab environment protection lives) and
//       no GitLab `when: manual` (a real `when` property of a GitLab job or rule,
//       not text in a command or block scalar; it never gates a GitHub
//       workflow). Bare and quoted keys are both recognized. A
//       `workflow_dispatch` trigger does NOT count:
//       it is an additional trigger, not an approval on the push run; OR
//   (b) that job selects a mutable ref (a `ref:` or `--ref` of
//       main/master/develop/HEAD, a `github.ref`/`github.ref_name`, or an
//       `@latest`/`:latest` tag) at all. A
//       line matcher cannot prove WHICH line is the deploy command, so a
//       `verified` reference elsewhere in the same job (a build download, a
//       tooling checkout) does NOT clear it — a mutable ref in the deploy job
//       stays unsafe. Deploy only the pinned `verified` pointer/artifact.
// Detection runs against a COMMENT-STRIPPED view, so a `#` comment can't fake a
// gate. See README for the exact heuristic and limits.
//
// Native Bun/TypeScript. Conventions (mirror ../pr-target-safety): exit 0 pass,
// 1 an unsafe workflow (per-file report), 2 a usage error; inputs via file args
// or WORKFLOWS_DIR so the self-test drives it with fixtures. A missing workflows
// dir (ENOENT) passes (safe to wire early); an unreadable one, or a path that is
// not a directory, fails closed.
//
// Usage:
//   check-promote-safety.ts                       # scan .github/workflows
//   check-promote-safety.ts path/to/deploy.yml    # explicit files
//   WORKFLOWS_DIR=path check-promote-safety.ts
import { readFileSync, readdirSync, lstatSync, statSync } from "node:fs";
type Job = {
  name: string;
  indent: number;
  deploy: boolean;
  prod: boolean;
  environment: boolean;
  manual: boolean;
  push: boolean;
  mutable: boolean;
};
// A mapping key, bare or quoted: `deploy:`, `"deploy-prod":`, `'on':`.
const keyOf = (line: string) => {
  const m = line.match(/^\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+))\s*:/);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : undefined;
};
const q = `["']?`;
// A real `when: manual` property: its own `when` key (block entry, list item or
// flow mapping), never text inside a command string or block scalar.
const manualEntry = new RegExp(
  `^\\s*(-\\s+)?${q}when${q}\\s*:\\s*${q}manual${q}\\s*$`,
);
const unquote = (s: string) => {
  const t = s.trim();
  return /^(".*"|'.*')$/.test(t) ? t.slice(1, -1).trim() : t;
};
// True when a single-line flow mapping (`{ a: b, when: manual }`, optionally a
// list item) has a top-level `when` entry whose value is `manual`. Entries
// split only at commas of the outer mapping: commas inside quoted strings
// (honoring `\"` escapes and the `''` escape) or nested `{}`/`[]` do not split.
// A mapping that does not close on the line, or has an unterminated string or
// unbalanced nesting, cannot be read confidently and is not treated as a gate.
function flowHasManual(line: string): boolean {
  const m = line.match(/^\s*(?:-\s+)?\{/);
  if (!m) return false;
  const entries: string[] = [];
  let quote = "",
    depth = 0,
    closed = false,
    start = m[0].length;
  for (let i = start; i < line.length && !closed; i++) {
    const c = line[i];
    if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = "";
    } else if (quote === "'") {
      if (c === "'" && line[i + 1] === "'") i++;
      else if (c === "'") quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "]" || c === "}") && depth > 0) depth--;
    else if (c === "}" || (c === "," && depth === 0)) {
      entries.push(line.slice(start, i));
      start = i + 1;
      closed = c === "}";
    }
  }
  if (!closed) return false;
  return entries.some((entry) => {
    const kv = entry.match(/^\s*("[^"]*"|'[^']*'|[^\s:'"]+)\s*:\s*(.*)$/);
    return (
      kv !== null &&
      unquote(kv[1] ?? "") === "when" &&
      unquote(kv[2] ?? "") === "manual"
    );
  });
}
const manualProperty = (s: string) => manualEntry.test(s) || flowHasManual(s);
const gitlabPush = (s: string) =>
  new RegExp(
    `ci_pipeline_source\\s*==\\s*['"]?push|^\\s*${q}only${q}\\s*:.*push|^\\s*-\\s*${q}pushes([^a-z]|$)`,
  ).test(s);
export function findings(content: string): { job: string; mode: "a" | "b" }[] {
  const lines = content
      .split(/\r?\n/)
      .map((l) => l.replace(/\s#.*$/, "").replace(/^\s*#.*$/, "")),
    jobsKey = new RegExp(`^\\s*${q}jobs${q}\\s*:\\s*$`),
    gha = lines.some((l) => jobsKey.test(l));
  const reserved = new Set(
    "stages variables default workflow include image services cache before_script after_script pages".split(
      " ",
    ),
  );
  const jobs = new Map<string, Job>();
  let saw = false,
    jobsIndent = -1,
    level = -1,
    cur: Job | undefined,
    push = false,
    scalarIndent = -1;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const lc = raw.toLowerCase(),
      ind = raw.length - raw.trimStart().length;
    if (gha && jobsKey.test(raw)) {
      saw = true;
      jobsIndent = ind;
      level = -1;
      cur = undefined;
      continue;
    }
    let header = false;
    const key = keyOf(raw);
    const inScalar = scalarIndent >= 0 && ind > scalarIndent;
    if (!inScalar)
      scalarIndent = /(^|[:-])\s*[|>](?:[+-][0-9]?|[0-9][+-]?)?\s*$/.test(raw)
        ? ind
        : -1;
    if (gha && saw) {
      if (ind <= jobsIndent) cur = undefined;
      else {
        if (level === -1 && key !== undefined) level = ind;
        if (level >= 0 && ind === level && key !== undefined) header = true;
      }
    } else if (!gha && ind === 0 && key !== undefined) {
      if (reserved.has(key ?? "")) {
        cur = undefined;
        continue;
      }
      header = true;
    }
    if (header) {
      const name = key ?? "";
      cur = jobs.get(name);
      if (!cur) {
        cur = {
          name,
          indent: -1,
          deploy: false,
          prod: false,
          environment: false,
          manual: false,
          push: false,
          mutable: false,
        };
        jobs.set(name, cur);
      }
    }
    if (!cur) {
      if (
        new RegExp(
          `^\\s*${q}on${q}\\s*:\\s*${q}push(["'\\s]|$)|^\\s*${q}on${q}\\s*:\\s*\\[[^\\]]*push|^\\s*${q}on${q}\\s*:\\s*\\{.*push|^\\s*-\\s*${q}push${q}\\s*$|^\\s*${q}push${q}\\s*:`,
        ).test(raw) ||
        gitlabPush(lc)
      )
        push = true;
      continue;
    }
    if (!header && cur.indent === -1) cur.indent = ind;
    cur.deploy ||= /deploy/.test(lc);
    cur.prod ||= /(^|[^a-z])(prod|production)([^a-z]|$)/.test(lc);
    cur.environment ||= ind === cur.indent && keyOf(raw) === "environment";
    cur.manual ||= !gha && !inScalar && manualProperty(lc);
    cur.push ||= gitlabPush(lc);
    cur.mutable ||=
      /(^|[^a-z])ref['"]?\s*:\s*['"]?(refs\/heads\/)?(main|master|develop|trunk|head)([^a-z]|$)|--ref[\s=]+['"]?(refs\/heads\/)?(main|master|develop|trunk|head)([^a-z]|$)|github\.ref(_name)?([^a-z]|$)|[:@]latest([^a-z]|$)/.test(
        lc,
      );
  }
  const result: { job: string; mode: "a" | "b" }[] = [];
  for (const j of jobs.values()) {
    if (!j.deploy || !j.prod) continue;
    if ((push || j.push) && !j.environment && !j.manual)
      result.push({ job: j.name, mode: "a" });
    if (j.mutable) result.push({ job: j.name, mode: "b" });
  }
  return result;
}
// Genuine absence (ENOENT) passes; anything else (permissions, a regular file
// where the directory should be, a dangling link) is an error, not a pass.
function directoryExists(dir: string): boolean {
  try {
    if (statSync(dir).isDirectory()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      lstatSync(dir);
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw inner;
    }
    throw new Error(`workflows path is a dangling link: ${dir}`);
  }
  throw new Error(`workflows path is not a directory: ${dir}`);
}
export function main(args = process.argv.slice(2), env = process.env): number {
  const dir = env.WORKFLOWS_DIR || ".github/workflows";
  let files = args;
  if (!files.length) {
    if (!directoryExists(dir)) {
      console.log(`OK — ${dir} does not exist (no workflows to check)`);
      return 0;
    }
    files = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => `${dir}/${f}`);
  }
  let bad = false;
  for (const f of files) {
    if (!statSync(f).isFile()) throw new Error(`not a file: ${f}`);
    for (const finding of findings(readFileSync(f, "utf8"))) {
      bad = true;
      console.log(`UNSAFE ${f}`);
      const j = finding.job;
      if (finding.mode === "a")
        console.log(
          `  (a) job '${j}' deploys to production and fires automatically on push with\n      nothing gating the push run (no environment: protection, no when: manual).\n      A workflow_dispatch trigger does not count. Fix: gate this job behind a\n      protected environment (or trigger the workflow only manually).\n`,
        );
      else
        console.log(
          `  (b) job '${j}' selects a mutable ref (a moving branch / HEAD / :latest).\n      A production deploy must ship ONLY the verified pointer/artifact; a\n      mutable ref means what reaches prod is whatever the branch is, not what\n      passed verification. A verified reference elsewhere in the job does not\n      clear this (the lint cannot prove the deploy uses it).\n      Fix: remove the mutable ref; deploy refs/tags/verified (or the verified artifact).\n`,
        );
    }
  }
  console.log(
    bad
      ? "Promote-safety lint FAILED — an unsafe production-deploy path was found."
      : "OK — no unsafe production-deploy workflows",
  );
  return bad ? 1 : 0;
}
if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}
