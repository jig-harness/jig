/**
 * `jig dispatch`: one tick of the dispatcher, as a report. It reads the
 * tracker, the forge's drive ledgers and the session runtime for each
 * repository and prints every stage it would start, with the record that
 * wants it and the evidence; it starts nothing. `--apply` is accepted and
 * refused until the step that launches re-arms is built.
 */
import { resolve } from "node:path";
import { consumerRoot } from "../shared/consumer.ts";
import { ExitError } from "../shared/cli.ts";
import { formatReceipt } from "./lib/report.ts";
import { readReceipt, receiptPaths } from "./receipts.ts";
import { runTick } from "./tick.ts";

const USAGE = `jig dispatch [--repo <path>]... [--followup-since <date>] [--json]
jig dispatch receipts [<run-id>]`;

/** Exit when another tick holds the lock. */
const LOCK_HELD_EXIT = 3;

const APPLY_REFUSAL =
  "jig dispatch --apply: refused. This version only reports; starting re-arms within each account's cap, and the timer that runs the tick, arrive with the dispatcher's build step 3. Run without --apply for the report.";

interface Options {
  repos: string[];
  json: boolean;
  apply: boolean;
  followupSince?: string;
}

function parseArguments(argv: string[]): Options {
  const options: Options = { repos: [], json: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === "--repo" || flag === "--followup-since") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--"))
        throw new ExitError(2, `Missing value for ${flag}`);
      if (flag === "--repo") options.repos.push(resolve(value));
      else {
        if (!Number.isFinite(Date.parse(value)))
          throw new ExitError(2, `--followup-since is not a date: ${value}`);
        options.followupSince = new Date(value).toISOString();
      }
      continue;
    }
    if (flag === "--json") options.json = true;
    else if (flag === "--apply") options.apply = true;
    else throw new ExitError(2, `Unknown argument: ${flag}\n${USAGE}`);
  }
  return options;
}

function showReceipts(argv: string[]): number {
  if (argv.length > 1) throw new ExitError(2, "receipts accepts one run id");
  const paths = receiptPaths();
  const id = argv[0];
  if (id === undefined) {
    for (const path of paths) {
      const r = readReceipt(path);
      if (r === null) continue;
      const actions = r.repos.reduce((n, repo) => n + repo.actions.length, 0);
      console.log(
        `${r.runId}  ${r.startedAt}  ${r.completed ? `exit ${r.exitStatus}` : "incomplete"}  ${r.repos.length} repositor${r.repos.length === 1 ? "y" : "ies"}, ${actions} action(s)  ${path}`,
      );
    }
    return 0;
  }
  const path = paths.find(
    (p) => p.endsWith(`/${id}.json`) || p.endsWith(`\\${id}.json`),
  );
  const receipt = path === undefined ? null : readReceipt(path);
  if (receipt === null) throw new ExitError(2, `No receipt ${id}`);
  console.log(JSON.stringify(receipt, null, 2));
  return 0;
}

export async function dispatchMain(argv: string[]): Promise<number> {
  if (argv[0] === "--help" && argv.length === 1) {
    console.log(USAGE);
    return 0;
  }
  if (argv[0] === "receipts") return showReceipts(argv.slice(1));
  const options = parseArguments(argv);
  if (options.apply) {
    console.error(APPLY_REFUSAL);
    return 2;
  }
  const result = await runTick({
    repos: options.repos.length > 0 ? options.repos : [consumerRoot()],
    ...(options.followupSince === undefined
      ? {}
      : { followupSince: options.followupSince }),
  });
  if ("held" in result) {
    console.error(`jig dispatch: another tick holds the lock: ${result.held}`);
    return LOCK_HELD_EXIT;
  }
  console.log(
    options.json
      ? JSON.stringify(result.receipt, null, 2)
      : formatReceipt(result.receipt, result.path),
  );
  return result.receipt.exitStatus;
}
