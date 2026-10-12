#!/usr/bin/env bun
// Auditor scoring aid — turn the modules' maturity.yaml criteria into a
// ready-to-fill scoring checklist, so a scored maturity assessment is a
// mechanical read of the criteria rather than a from-memory exercise.
//
// Every module ships machine-evaluable criteria (modules/README.md §
// "maturity.yaml schema"): each criterion carries an id, the maturity `level`
// where it first becomes required (lite | standard | strict), the `requires`
// rung (convention | mechanical), and a one-sentence observable `statement`.
// This script reads them all and emits one markdown table per module with an
// empty Score and Evidence column for the auditor to fill in against a target
// repo (paste into the report under "Module scores").
//
// Two modes:
//   score-modules.ts [modules-dir]      # default: print the fill-in checklist
//   score-modules.ts --check [modules-dir]
//       # coverage gate: every M0..M12 has a maturity.yaml with >=1 criterion,
//       # so a module that loses or never gets its criteria fails loudly.
//
// Native Bun/TypeScript. Exit 0 ok, 1 --check failure, 2 when the modules
// directory does not exist.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
export function main(args = process.argv.slice(2)): number {
  const check = args[0] === "--check";
  if (check) args = args.slice(1);
  const modules = args[0] || join(dirname(import.meta.dir), "modules");
  if (!existsSync(modules))
    throw new Error(`modules dir not found: ${modules}`);
  const files = readdirSync(modules, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() && existsSync(join(modules, d.name, "maturity.yaml")),
    )
    .sort(
      (a, b) =>
        Number(a.name.match(/^M(\d+)/)?.[1] || 0) -
        Number(b.name.match(/^M(\d+)/)?.[1] || 0),
    )
    .map((d) => join(modules, d.name, "maturity.yaml"));
  const extract = (file: string) => {
    let module = "",
      name = "";
    const rows: { id: string; level: string; requires: string }[] = [];
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      if (/^module:/.test(line)) module = line.trim().split(/\s+/)[1] || "";
      if (/^name:/.test(line)) name = line.trim().split(/\s+/)[1] || "";
      const id = line.match(/^ {2}- id:\s*(\S+)/);
      if (id) rows.push({ id: id[1] ?? "", level: "", requires: "" });
      const row = rows.at(-1);
      const field = line.match(/^ {4}(level|requires):\s*(\S+)/);
      if (row && field) row[field[1] as "level" | "requires"] = field[2] ?? "";
    }
    return { module, name, rows };
  };
  if (check) {
    let bad = false;
    for (let n = 0; n <= 12; n++) {
      const file = files.find((f) =>
        new RegExp(`^M${n}-`).test(basename(dirname(f))),
      );
      if (!file) {
        console.log(`MISSING: M${n} has no maturity.yaml`);
        bad = true;
        continue;
      }
      const count = extract(file).rows.length;
      if (!count) {
        console.log(`EMPTY: M${n} (${file}) has no criteria`);
        bad = true;
      } else console.log(`ok: M${n} — ${count} criteria`);
    }
    if (!bad)
      console.log("All 13 modules (M0–M12) carry machine-evaluable criteria.");
    return bad ? 1 : 0;
  }
  console.log(
    "# Module scoring checklist\n\nGenerated from each module's `maturity.yaml`. For every criterion, record\nthe observed rung — `absent` / `convention` / `advisory` / `mechanical` —\nwith a file-path evidence note. A module attains a maturity level when every\ncriterion at that level *and below* meets its `requires` rung.\n",
  );
  for (const file of files) {
    const { module, name, rows } = extract(file);
    console.log(
      `## ${module} — ${name}\n\n| Criterion | Level | Requires | Score | Evidence |\n|-----------|-------|----------|-------|----------|`,
    );
    for (const row of rows)
      console.log(`| ${row.id} | ${row.level} | ${row.requires} |  |  |`);
    console.log("");
  }
  return 0;
}
if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}
