/**
 * The jobs of a repository's GitHub Actions workflows, as the detector and
 * the skills that compare a gate command with CI read them: each job's file,
 * id and check name, whether a pull request runs it, the jobs it waits for,
 * and the command lines of its `run` steps that run at the repository's root
 * in a POSIX shell, each with the environment variables set for it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMapping as isRecord } from "../config-layers.ts";
import { swallow } from "../errors.ts";
import { load } from "../yaml.ts";
import { texts } from "./read.ts";

/** GitHub Actions workflows. */
const GITHUB_WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** A CI job: where it is, the name its check run takes, and the commands its steps run. */
export interface CiJob {
  file: string;
  id: string;
  name: string;
  pullRequest: boolean;
  /** The ids of the jobs it waits for. */
  needs: string[];
  commands: CiLine[];
  /** The `run` steps not read: their lines are not each a command run at the root. */
  unread: number;
}

/**
 * One command line of a `run` step, with the environment variables the
 * workflow, job or step sets for it: what the line runs reads them, and a
 * configuration value repeating the line alone would not set them.
 */
export interface CiLine {
  text: string;
  env: string[];
}

/** Whether a workflow's `on` names a pull-request event. */
function onPullRequest(on: unknown): boolean {
  const events = ["pull_request", "pull_request_target"];
  if (typeof on === "string") return events.includes(on);
  if (Array.isArray(on)) return on.some((e) => events.includes(e));
  return isRecord(on) && events.some((e) => Object.hasOwn(on, e));
}

/** Shell words that open or close a compound command, which spans lines. */
const COMPOUND =
  /^(if|then|else|elif|fi|for|while|until|do|done|case|esac|select|function|\{|\}|\(|\))(\s|;|$)/;

/**
 * Text that may open a here-document or change folder: `<<` anywhere, or
 * `cd`, `pushd` or `popd` as a word anywhere. Matched on the raw line,
 * comments included and quote marks and backslashes removed (`c'd'` and
 * `c\d` run `cd`), so it can only over-read.
 */
const NOT_AT_ROOT = /<<|(^|[^\w./-])(cd|pushd|popd)(?![\w./-])/;

/** Whether a line may open a here-document or change folder, in any quoting. */
function notAtRoot(line: string): boolean {
  return NOT_AT_ROOT.test(line.replace(/['"\\]/g, ""));
}

/**
 * The command lines of a `run` block: continuations joined, blanks and
 * comments dropped; null when the block is not read. A block is read only
 * when its lines are each a command run at the repository's root: a compound
 * command (`if`, `for`, …) runs depending on its conditions, a
 * here-document's lines are input, and a `cd` moves what follows it to
 * another folder. Those are recognised by text, not parsed, so a block that
 * only mentions one (`echo '<<EOF'`) is not read either, and the caller says
 * so rather than reading it as running nothing.
 */
function runLines(run: string): string[] | null {
  const lines = run
    .replace(/\s*\\\r?\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const unread = lines.some((line) => COMPOUND.test(line) || notAtRoot(line));
  return unread ? null : lines;
}

/** The names of the environment variables an `env` setting sets; an expression sets ones unknown. */
function envNames(env: unknown): string[] {
  if (env === undefined || env === null) return [];
  return isRecord(env) ? Object.keys(env) : ["(an expression)"];
}

/**
 * Whether `defaults` makes `run` steps start in another folder or another
 * shell, where the repository's root scripts do not say what a command runs.
 */
function runsElsewhere(defaults: unknown): boolean {
  const run = isRecord(defaults) ? defaults.run : undefined;
  return (
    isRecord(run) &&
    (run["working-directory"] !== undefined || !shellLike(run.shell))
  );
}

/** Whether a step's `shell` is a POSIX shell, or unset. */
function shellLike(shell: unknown): boolean {
  return (
    shell === undefined ||
    (typeof shell === "string" && /^(bash|sh)\b/.test(shell))
  );
}

/**
 * The command lines of a `run` step that runs at the root in a POSIX shell,
 * each with the environment `inherited` from its workflow and job and the
 * step's own; null for a `run` step that is not read: one in another folder
 * or shell, or a block {@link runLines} does not read.
 */
function stepLines(step: unknown, inherited: string[]): CiLine[] | null {
  if (!isRecord(step) || typeof step.run !== "string") return [];
  if (step["working-directory"] !== undefined || !shellLike(step.shell))
    return null;
  const env = [...new Set([...inherited, ...envNames(step.env)])];
  return runLines(step.run)?.map((text) => ({ text, env })) ?? null;
}

/** The jobs of the repository's GitHub Actions workflows that parse. */
export function ciJobs(root: string, files: string[]): CiJob[] {
  return files
    .filter((f) => GITHUB_WORKFLOW.test(f))
    .flatMap((file) => {
      try {
        return workflowJobs(file, load(readFileSync(join(root, file), "utf8")));
      } catch (error) {
        swallow(error, `${file} does not parse: its jobs are not compared`);
        return [];
      }
    });
}

/** The jobs of one parsed workflow. */
function workflowJobs(file: string, doc: unknown): CiJob[] {
  if (!isRecord(doc) || !isRecord(doc.jobs)) return [];
  const pullRequest = onPullRequest(doc.on);
  const elsewhere = runsElsewhere(doc.defaults);
  return Object.entries(doc.jobs).flatMap(([id, job]) => {
    if (!isRecord(job)) return [];
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const away = elsewhere || runsElsewhere(job.defaults);
    const env = [...envNames(doc.env), ...envNames(job.env)];
    const read = steps.map((step) =>
      away && isRecord(step) && typeof step.run === "string"
        ? null
        : stepLines(step, env),
    );
    return [
      {
        file,
        id,
        name: typeof job.name === "string" ? job.name : id,
        pullRequest,
        needs: typeof job.needs === "string" ? [job.needs] : texts(job.needs),
        commands: read.flatMap((lines) => lines ?? []),
        unread: read.filter((lines) => lines === null).length,
      },
    ];
  });
}
