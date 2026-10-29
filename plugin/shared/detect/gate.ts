/**
 * The command that runs a repository's whole check (`gates.command`), from
 * its shape: a gate script CI runs, else a package script, else a make
 * target, else a gate script CI does not run.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { swallow } from "../errors.ts";
import { type CiLine, ciJobs } from "./ci-jobs.ts";
import { beforeComment, commandWords, scan } from "./command-line.ts";
import type { Fact } from "./fact.ts";
import { detectPackageManager } from "./package-manager.ts";
import { packageScripts, runsDirectly } from "./read.ts";

/**
 * The makefile `make` would read, by its exact name: listed rather than
 * tested with `existsSync`, which on a case-insensitive file system finds
 * `makefile` when the file is `Makefile`.
 */
export function makefileOf(root: string): string | undefined {
  const names = new Set(readdirSync(root));
  return ["GNUmakefile", "makefile", "Makefile"].find((f) => names.has(f));
}

/**
 * A command that runs the repository's checks, and what shows it;
 * `unsettled` names what keeps it from being the whole check CI runs.
 */
type Gate = { command: string; evidence: string; unsettled?: string };

/** The package script that runs the repository's checks, with its runner. */
function scriptGate(root: string): Gate | null {
  const scripts = packageScripts(root) ?? {};
  const name = ["gates", "check", "ci", "verify", "validate", "test"].find(
    (n) => Object.hasOwn(scripts, n),
  );
  if (name === undefined) return null;
  const found = detectPackageManager(root).found;
  const manager = found?.name ?? "npm";
  const runner = found
    ? `, and ${found.lockfile} makes ${manager} its package manager`
    : "";
  return {
    command: `${manager} run ${name}`,
    evidence: `package.json defines a "${name}" script${runner}`,
  };
}

/** The make target that runs the repository's checks. */
function makeGate(root: string): Gate | null {
  const makefile = makefileOf(root);
  if (makefile === undefined) return null;
  const text = readFileSync(join(root, makefile), "utf8");
  const target = ["gates", "check", "ci", "verify"].find((t) =>
    new RegExp(`^${t}\\s*:`, "m").test(text),
  );
  if (target === undefined) return null;
  return {
    command: `make ${target}`,
    evidence: `${makefile} defines a "${target}" target`,
  };
}

/** A tracked script named like the repository's whole check, at the root or under `scripts/` or `bin/`. */
const GATE_SCRIPT =
  /^(?:(?:scripts|bin)\/)?(gates?|checks?|verify|ci)(?:\.(?:sh|bash))?$/;

/**
 * One command of a CI line that runs a gate script, as CI writes it (with
 * the environment it sets, if any) and as a configuration could repeat it.
 */
type CiRun = { written: string; env: string; command: string | null };

/**
 * The commands of a CI command line that run the gate script `file`,
 * directly or through `bash` or `sh`. A mention in an argument
 * (`echo ./scripts/gates.sh`) or after a comment runs nothing, and a line
 * whose syntax changes how its quotes are read shows nothing reliably. Each
 * run's `command` repeats it exactly, interpreter and arguments kept; it is
 * null when no configuration value can: a leading assignment or `env`
 * prefix, or an `env` setting of the workflow, job or step, sets what the
 * script reads, and an argument with expansion, quoting or space reads
 * differently pasted elsewhere.
 */
function ciRuns(line: CiLine, file: string): CiRun[] {
  const { segments, requoted } = scan(beforeComment(line.text));
  if (requoted) return [];
  return segments.flatMap((segment) => {
    const words = commandWords(segment);
    if (typeof words === "string") return [];
    const shell = words[0] === "bash" || words[0] === "sh" ? words[0] : null;
    const at = shell === null ? 0 : 1;
    if (words[at]?.replace(/^\.\//, "") !== file) return [];
    const args = words.slice(at + 1);
    const repeatable =
      line.env.length === 0 &&
      words.length === segment.length &&
      args.every((a) => PLAIN_ARGUMENT.test(a));
    const base = shell === null ? `./${file}` : `${shell} ${file}`;
    const env = line.env.length === 0 ? "" : ` with ${line.env.join(", ")} set`;
    return [
      {
        written: segment.join(" "),
        env,
        command: repeatable ? [base, ...args].join(" ") : null,
      },
    ];
  });
}

/** An argument that reads the same pasted into a configuration: no expansion, quoting or space. */
const PLAIN_ARGUMENT = /^[\w.,=:/@+%-]+$/;

/**
 * The tracked gate scripts ({@link GATE_SCRIPT}) a shell can run: an
 * executable one as `./<path>`, a shell script without the executable bit
 * through `bash`. One a CI job's `run` step invokes comes first, with the
 * workflow named in its evidence. When every CI run of it is the same
 * repeatable command, that command is the one found, so it runs what CI
 * runs; otherwise the one found is the bare script, marked `unsettled`
 * with the runs CI makes, for a reader to choose from.
 */
function scriptFileGates(
  root: string,
  files: string[],
): (Gate & { ci: boolean })[] {
  const jobs = ciJobs(root, files);
  const gates = files.flatMap((file) => {
    const match = GATE_SCRIPT.exec(file);
    if (match === null) return [];
    let mode: number;
    try {
      mode = statSync(join(root, file)).mode;
    } catch (error) {
      swallow(error, `${file} is tracked but missing from the working tree`);
      return [];
    }
    const executable = runsDirectly(root, file, mode);
    if (!executable && !/\.(sh|bash)$/.test(file)) return [];
    const { runBy, settled, unsettled } = ciSettlement(
      jobs.flatMap((job) =>
        job.commands.flatMap((line) =>
          ciRuns(line, file).map((run) => ({ ...run, file: job.file })),
        ),
      ),
    );
    const base = executable ? `./${file}` : `bash ${file}`;
    const kind = executable ? "an executable script" : "a shell script";
    const ci =
      runBy.length === 0
        ? ""
        : `, and CI runs it (${runBy.join(", ")})${unsettled === undefined ? "" : `; ${unsettled}`}`;
    return [
      {
        command: settled ?? base,
        evidence: `${file} is ${kind} named like the repository's check${ci}`,
        ci: runBy.length > 0,
        ...(unsettled === undefined ? {} : { unsettled }),
      },
    ];
  });
  return [...gates.filter((g) => g.ci), ...gates.filter((g) => !g.ci)];
}

/**
 * What a gate script's CI runs settle: the workflows that run it, the one
 * command every run is when there is one, and otherwise how CI runs it.
 */
function ciSettlement(runs: (CiRun & { file: string })[]): {
  runBy: string[];
  settled: string | null;
  unsettled?: string;
} {
  const runBy = [...new Set(runs.map((r) => r.file))];
  const commands = [...new Set(runs.map((r) => r.command))];
  const settled = commands.length === 1 ? (commands[0] ?? null) : null;
  if (runs.length === 0 || settled !== null) return { runBy, settled };
  const written = [...new Set(runs.map((r) => `\`${r.written}\`${r.env}`))];
  return { runBy, settled, unsettled: `CI runs it as ${written.join(", ")}` };
}

/**
 * The command that runs the repository's checks, as the repository's shape
 * names it: a gate script CI runs, else a package script, else a make
 * target, else a gate script CI does not run; null when none is found.
 * `unsettled` names what keeps the command from being the whole check CI
 * runs, when something does.
 */
export function gateCommand(
  root: string,
  files: string[],
): (Fact & { value: string; unsettled?: string }) | null {
  const scripts = scriptFileGates(root, files);
  const gate =
    scripts.find((g) => g.ci) ??
    scriptGate(root) ??
    makeGate(root) ??
    scripts[0] ??
    null;
  if (gate === null) return null;
  return {
    field: "gates.command",
    value: gate.command,
    evidence: [gate.evidence],
    ...(gate.unsettled === undefined ? {} : { unsettled: gate.unsettled }),
  };
}
