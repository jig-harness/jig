#!/usr/bin/env bun
/**
 * The Notion store: reflections in a Notion database, behind the store
 * contract.
 *
 * Usage:
 *   bun notion-store.ts --database <id or link> <check|append|list|diagnose|repair>
 *   bun notion-store.ts init --parent <page id or link>
 *
 *   check     {"ok":true}, or {"ok":false,"reason":…,"fix":…}
 *   append    JSONL events on stdin → {"stored":[{"id":…,"ref":…}]}
 *   list      optional {"since":…} on stdin → JSONL events, each id once
 *   diagnose  JSONL notices: ids stored with different events, and pages
 *             whose Status a person changed by hand
 *   repair    recomputes every page's properties from the events
 *   init      creates the database, its properties and views under a page
 *             the integration can see, and prints the setting to add
 *
 * One page per change (its issue key, else its branch, per repository);
 * each event is a JSON code block in a collapsed toggle on that page, and
 * `list` reads those blocks and nothing else. The page properties are
 * recomputed from the events after every write.
 *
 * The integration's secret is read from NOTION_TOKEN. JIG_NOTION_API_URL
 * points the store at another endpoint, https or a local one over http (a
 * local fake in the tests), and
 * JIG_NOTION_INTERVAL_MS sets the least time between two requests (340 by
 * default, Notion's average of three a second).
 *
 * Exit codes: 0 done; 1 failed (the reason on stderr); 2 usage; 3 Notion is
 * unreachable, or the token is missing or refused.
 */
import { runMain } from "../../../shared/cli.ts";
import { NotionApi, NotionError } from "./lib/notion/api.ts";
import { notionId } from "./lib/notion/ids.ts";
import { appendInput, sinceInput } from "./lib/store-io.ts";
import {
  appendEvents,
  createDatabase,
  type Database,
  diagnose,
  isUnusable,
  listOutput,
  missingProperties,
  openDatabase,
  readStore,
  repair,
} from "./lib/notion/store.ts";

const USAGE = [
  "usage: notion-store.ts --database <id or link> <check|append|list|diagnose|repair>",
  "       notion-store.ts init --parent <page id or link>",
].join("\n");

const NO_TOKEN = {
  reason: "NOTION_TOKEN is not set",
  fix: "create an internal integration at https://www.notion.so/profile/integrations, share the store's page with it, and export its secret as NOTION_TOKEN",
};

function usage(message: string): number {
  console.error(`${message}\n${USAGE}`);
  return 2;
}

function apiOrUnavailable(): NotionApi {
  const api = NotionApi.fromEnv();
  if (api === null)
    throw new NotionError(3, `${NO_TOKEN.reason}: ${NO_TOKEN.fix}`);
  return api;
}

async function opened(api: NotionApi, id: string): Promise<Database> {
  const database = await openDatabase(api, id);
  if (isUnusable(database))
    throw new NotionError(1, `${database.reason}: ${database.fix}`);
  return database;
}

async function check(id: string): Promise<number> {
  const say = (value: Record<string, unknown>): number => {
    console.log(JSON.stringify(value));
    return 0;
  };
  const api = NotionApi.fromEnv();
  if (api === null) return say({ ok: false, ...NO_TOKEN });
  let database: Awaited<ReturnType<typeof openDatabase>>;
  try {
    database = await openDatabase(api, id);
  } catch (error) {
    if (error instanceof NotionError && error.status === 401)
      return say({
        ok: false,
        reason: error.message,
        fix: "export the integration's current secret as NOTION_TOKEN",
      });
    throw error;
  }
  if (isUnusable(database)) return say({ ok: false, ...database });
  const missing = await missingProperties(api, database);
  if (missing.length > 0)
    return say({
      ok: false,
      reason: `the database lacks the properties ${missing.join(", ")}`,
      fix: "add them back with those names and types, or create a new database with notion-store.ts init",
    });
  return say({ ok: true });
}

async function append(id: string): Promise<number> {
  const input = await appendInput();
  if ("problem" in input) {
    console.error(input.problem);
    return 1;
  }
  const lines = input.events;
  if (lines.length === 0) {
    console.log(JSON.stringify({ stored: [] }));
    return 0;
  }
  const api = apiOrUnavailable();
  const result = await appendEvents(api, await opened(api, id), lines);
  for (const failure of result.propertyFailures)
    console.error(
      `the properties of ${failure} were not updated; the events are stored, and a later write to the page, sending the same events again, or notion-store.ts repair recomputes them`,
    );
  console.log(JSON.stringify({ stored: result.stored }));
  return 0;
}

async function list(id: string): Promise<number> {
  const after = await sinceInput();
  const api = apiOrUnavailable();
  const pages = await readStore(api, await opened(api, id));
  for (const text of listOutput(pages, after))
    process.stdout.write(`${text}\n`);
  return 0;
}

async function diagnoseOp(id: string): Promise<number> {
  const api = apiOrUnavailable();
  for (const notice of await diagnose(api, await opened(api, id)))
    process.stdout.write(`${JSON.stringify(notice)}\n`);
  return 0;
}

async function repairOp(id: string): Promise<number> {
  const api = apiOrUnavailable();
  const result = await repair(api, await opened(api, id));
  console.log(
    JSON.stringify({
      pages: result.synced.length,
      status_kept: result.synced
        .filter((synced) => synced.kept)
        .map(({ ref, shown, computed }) => ({ ref, shown, computed })),
      failed: result.failures,
    }),
  );
  for (const failure of result.failures) console.error(failure);
  return result.failures.length === 0 ? 0 : 1;
}

async function init(parent: string): Promise<number> {
  const api = apiOrUnavailable();
  const created = await createDatabase(api, parent);
  for (const failure of created.viewFailures)
    console.error(
      `the view ${failure}; the store works without it, and you can add it in Notion`,
    );
  console.log(
    [
      `# Created ${created.url}`,
      "# Add this to ~/.jig/jig.yaml, or to a repository's .config/jig.yaml:",
      "reflection:",
      "  store: notion",
      "  notion:",
      `    database: ${created.database}`,
    ].join("\n"),
  );
  return 0;
}

/** The operations that work on a database, by name. */
const ON_DATABASE: Record<string, (id: string) => Promise<number>> = {
  check,
  append,
  list,
  diagnose: diagnoseOp,
  repair: repairOp,
};

interface Command {
  op: string;
  database?: string;
  parent?: string;
}

/**
 * The operation and its options. The caller appends the operation to the
 * configured command, so it may come after the options.
 */
function parseCommand(argv: readonly string[]): Command | string {
  const command: Partial<Command> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = argv[i + 1];
    if (arg === "--database" && value !== undefined) command.database = value;
    else if (arg === "--parent" && value !== undefined) command.parent = value;
    else if (command.op === undefined && !arg.startsWith("--")) {
      command.op = arg;
      continue;
    } else return `unknown argument: ${arg}`;
    i++;
  }
  if (command.op === undefined) return "missing operation";
  return command as Command;
}

/** The work a command line asks for, or the usage problem with it. */
function chooseWork(command: Command): (() => Promise<number>) | string {
  if (command.op === "init") {
    if (command.database !== undefined)
      return "init takes --parent, not --database";
    const parent = notionId(command.parent ?? "");
    return parent === null
      ? "init needs --parent <page id or link>"
      : () => init(parent);
  }
  const operation = Object.hasOwn(ON_DATABASE, command.op)
    ? ON_DATABASE[command.op]
    : undefined;
  if (operation === undefined) return `unknown operation: ${command.op}`;
  if (command.parent !== undefined)
    return `${command.op} takes --database, not --parent`;
  const database = notionId(command.database ?? "");
  return database === null
    ? "--database <id or link> is required"
    : () => operation(database);
}

export async function main(argv: string[]): Promise<number> {
  const command = parseCommand(argv);
  const work = typeof command === "string" ? command : chooseWork(command);
  if (typeof work === "string") return usage(work);
  try {
    return await work();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof NotionError ? error.code : 1;
  }
}

if (import.meta.main)
  runMain("notion-store.ts", () => main(process.argv.slice(2)));
