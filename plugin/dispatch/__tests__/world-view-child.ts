/**
 * Ticks the world-view tests run in a child, in their world's home
 * (fixtures.ts), each over a world view the child makes: run as
 * `bun world-view-child.ts <mode>`, it prints a `ChildResult` and exits 0.
 *
 * - `replay`: one tick over the direct view, recording every fact it
 *   returns; the forge then refuses every call the view covers; a second
 *   tick over a view that replays the recorded facts, reading nothing.
 * - `gate`: the same recording tick; then PR #8's comments on the forge
 *   become what `gate-comments-8.json` holds, where one exists; a second
 *   tick with `--apply` over the replayed facts, whose launch reads the
 *   forge at use.
 * - `frozen`: one tick over the direct view whose forge facts are frozen
 *   when returned, so a write into one is a defect of its repository's
 *   turn; the facts as returned and as they stood after the tick.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TickReceipt } from "../receipts.ts";
import { readMachineConfig } from "../lib/machine-config.ts";
import type { ForgeRead } from "../lib/tick-forge.ts";
import type { Tracked } from "../lib/tick-tracker.ts";
import type {
  ConfigurationOutcome,
  Fact,
  ForgeFacts,
  TargetOutcome,
  WorldView,
} from "../lib/world-view.ts";
import { runTick } from "../tick.ts";
import type { RepoReport } from "../lib/types.ts";

/** What the child prints. */
export interface ChildResult {
  /** Each tick's receipt, in the order they ran. */
  receipts: TickReceipt[];
  /** Each fact the recorded view returned, by method, with its class. */
  classes: Array<{
    method: string;
    freshness: string;
    pullRequests?: Record<string, string>;
  }>;
  /** `frozen` only: PR #7's drive class in the forge facts as returned, and as they stood after the tick. */
  forgeDrive?: { returned: string | null; after: string | null };
}

/** The calls the forge refuses while the replayed tick runs: each read the world view covers. */
export const COVERED_CALLS = [
  "query DispatchRepository",
  "repo view",
  "pr list",
  ".config/jig.yaml",
  "api user",
  "issues/5/comments",
];

/** The line the child writes into the forge's call log before its second tick. */
export const SECOND_TICK = "-- second tick --";

/** What one method call added to its report. */
interface ReportPart {
  records: RepoReport["records"];
  unplaced: RepoReport["unplaced"];
}

/** The facts a recorded tick returned, by method and repository. */
interface Recorded {
  target: Map<string, TargetOutcome>;
  configuration: Map<string, ConfigurationOutcome>;
  tracker: Map<string, { fact: Fact<Tracked>; part: ReportPart }>;
  forge: Map<string, { facts: ForgeFacts; part: ReportPart }>;
  classes: ChildResult["classes"];
}

/** What `report` gained since it held `before`. */
function partOf(
  report: RepoReport,
  before: { records: number; unplaced: number },
): ReportPart {
  return {
    records: copy(report.records.slice(before.records)),
    unplaced: copy(report.unplaced.slice(before.unplaced)),
  };
}

const lengths = (report: RepoReport) => ({
  records: report.records.length,
  unplaced: report.unplaced.length,
});

/** `value` copied: its arrays, maps, sets and plain objects anew, anything else (a function, a tracker's handle) shared. */
function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value instanceof Map)
    return new Map([...value].map(([k, v]) => [k, copy(v)])) as T;
  if (value instanceof Set) return new Set([...value].map(copy)) as T;
  if (value === null || typeof value !== "object") return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, copy(v)]),
  ) as T;
}

/** The direct view, each fact it returns kept in `into`. */
function recording(direct: WorldView, into: Recorded): WorldView {
  return {
    async target(path) {
      const answer = await direct.target(path);
      into.target.set(path, copy(answer));
      if (answer.ok)
        into.classes.push({
          method: "target",
          freshness: answer.value.freshness,
        });
      return answer;
    },
    async configuration(path, repo) {
      const answer = await direct.configuration(path, repo);
      into.configuration.set(path, copy(answer));
      if (answer.ok)
        into.classes.push({
          method: "configuration",
          freshness: answer.value.freshness,
        });
      return answer;
    },
    gatherQueues: (opened, context) => direct.gatherQueues(opened, context),
    async tracker(request) {
      const before = lengths(request.report);
      const fact = await direct.tracker(request);
      into.tracker.set(request.repo.slug, {
        fact: { ...fact, value: copy(fact.value) },
        part: partOf(request.report, before),
      });
      into.classes.push({ method: "tracker", freshness: fact.freshness });
      return fact;
    },
    async forge(request) {
      const before = lengths(request.report);
      const facts = await direct.forge(request);
      into.forge.set(request.repo.slug, {
        facts: copy(facts),
        part: partOf(request.report, before),
      });
      into.classes.push({
        method: "forge",
        freshness: facts.freshness,
        pullRequests: Object.fromEntries(
          [...facts.pullRequests].map(([n, c]) => [String(n), c]),
        ),
      });
      return facts;
    },
  };
}

/** A view that serves what `recorded` holds and reads nothing. */
function replaying(recorded: Recorded): WorldView {
  const missing = (what: string): never => {
    throw new Error(`the recorded world holds no ${what}`);
  };
  const add = (report: RepoReport, part: ReportPart) => {
    report.records.push(...copy(part.records));
    report.unplaced.push(...copy(part.unplaced));
  };
  return {
    target: async (path) =>
      copy(recorded.target.get(path) ?? missing(`target of ${path}`)),
    configuration: async (path) =>
      copy(
        recorded.configuration.get(path) ?? missing(`configuration of ${path}`),
      ),
    gatherQueues: async () => undefined,
    async tracker(request) {
      const held =
        recorded.tracker.get(request.repo.slug) ??
        missing(`tracker of ${request.repo.slug}`);
      add(request.report, held.part);
      return { ...held.fact, value: copy(held.fact.value) };
    },
    async forge(request) {
      const held =
        recorded.forge.get(request.repo.slug) ??
        missing(`forge of ${request.repo.slug}`);
      add(request.report, held.part);
      return copy(held.facts);
    },
  };
}

/** `value` and everything it holds, frozen. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const inner of Object.values(value as Record<string, unknown>))
    deepFreeze(inner);
  return Object.freeze(value);
}

/** PR #7's drive class in `read`. */
const classOf7 = (read: ForgeRead | null) =>
  read?.drives.find((d) => d.number === 7)?.class ?? null;

async function tick(
  apply: boolean,
  world: (direct: WorldView) => WorldView,
): Promise<TickReceipt> {
  const read = readMachineConfig();
  if (!read.ok) throw new Error(read.failure.reason);
  const machine = read.value;
  if (machine === null)
    throw new Error("the world-view ticks need a machine file");
  const result = await runTick({
    repos: machine.repositories.map((r) => r.path),
    apply,
    machine,
    followupSince: "2026-10-30T00:00:00Z",
    world,
  });
  if ("held" in result)
    throw new Error(`another tick holds the lock: ${result.held}`);
  return result.receipt;
}

async function main(mode: string | undefined): Promise<ChildResult> {
  const fake = process.env.DISPATCH_FAKE_DIR ?? "";
  const recorded: Recorded = {
    target: new Map(),
    configuration: new Map(),
    tracker: new Map(),
    forge: new Map(),
    classes: [],
  };
  if (mode === "frozen") {
    let returned: ForgeRead | null = null;
    let frozen: ForgeRead | null = null;
    const receipt = await tick(false, (direct) => ({
      ...direct,
      async forge(request) {
        const facts = await direct.forge(request);
        returned = copy(facts.value);
        frozen = deepFreeze(facts.value);
        return facts;
      },
    }));
    return {
      receipts: [receipt],
      classes: [],
      forgeDrive: { returned: classOf7(returned), after: classOf7(frozen) },
    };
  }
  const first = await tick(false, (direct) => recording(direct, recorded));
  appendFileSync(join(fake, "gh-calls.log"), `${SECOND_TICK}\n`);
  if (mode === "gate") {
    // The ledger moves on the forge after the plan's facts were read.
    const moved = join(fake, "gate-comments-8.json");
    if (existsSync(moved))
      writeFileSync(join(fake, "comments-8.json"), readFileSync(moved, "utf8"));
    return {
      receipts: [first, await tick(true, () => replaying(recorded))],
      classes: recorded.classes,
    };
  }
  const fails = join(fake, "forge-fails.json");
  const rules = existsSync(fails)
    ? JSON.parse(readFileSync(fails, "utf8"))
    : [];
  writeFileSync(
    fails,
    JSON.stringify([
      ...rules,
      ...COVERED_CALLS.map((match) => ({
        match,
        stderr: `gh: the world view covers ${match} (HTTP 403)`,
      })),
    ]),
  );
  return {
    receipts: [first, await tick(false, () => replaying(recorded))],
    classes: recorded.classes,
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(await main(process.argv[2])));
  process.exit(0);
}
