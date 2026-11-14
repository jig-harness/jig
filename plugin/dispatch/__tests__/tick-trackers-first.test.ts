/** The tick gathers every repository's configuration before deriving any repository's work. */
import { afterEach, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { type World, world } from "./fixtures.ts";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

it("opens every eligible repository before observing one, retaining per-repository defect boundaries", async () => {
  const w = world();
  current = w;
  const other = join(w.root, "other");
  mkdirSync(other);
  const dispatch = resolve(import.meta.dir, "..");
  const entry = join(w.root, "trackers-first.ts");
  writeFileSync(
    entry,
    `
import { mock } from "bun:test";
const observation = ${JSON.stringify(`${dispatch}/lib/tick-observe.ts`)};
const real = await import(observation);
const { emptyReport } = await import(${JSON.stringify(`${dispatch}/lib/tick-context.ts`)});
const events = [];
const paths = process.argv.slice(2);
const trackers = ${JSON.stringify(resolve(import.meta.dir, "../../skills/do-item/scripts/lib/tracker/index.ts"))};
const trackerModule = await import(trackers);
mock.module(trackers, () => ({ ...trackerModule, openTracker: (config) => ({ adapter: "github", team: "sample/issues", stateName: (state) => state, dispatchSource: {
  credential: async () => "fixture", requirements: [config.github.repository],
  configure: (union) => events.push(["configured", union]),
} }) }));
const views = ${JSON.stringify(`${dispatch}/lib/sources/served-reads.ts`)};
const viewModule = await import(views);
mock.module(views, () => ({ ...viewModule, sharedView: async (_views, tracker, identity) => {
  events.push(["queue", identity]);
} }));
mock.module(observation, () => ({
  ...real,
  openRepo: async (path) => {
    if (path === paths[1]) {
      // A repository whose configuration completes later, without a clock-dependent wait.
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    events.push(["opened", path]);
    return {
      repo: { path, slug: path === paths[0] ? "sample/first" : "sample/second", defaultBranch: "main" },
      values: {}, section: { identity: "factory", states: ["todo"] }, stages: new Set(), owner: false,
      reflection: null, report: emptyReport(path, ""),
    };
  },
  observeRepo: async (opened) => {
    events.push(["observed", opened.repo.path]);
    throw new TypeError("fixture stops after observing");
  },
}));
const { runTick } = await import(${JSON.stringify(`${dispatch}/tick.ts`)});
const result = await runTick({ repos: paths });
if ("held" in result) process.exit(3);
console.log(JSON.stringify({ events, receipt: result.receipt }));
process.exit(result.receipt.exitStatus);
`,
  );
  const child = await w.dispatch([w.repo, other], entry);
  expectSpawnExit(child, 1);
  expect(child.stdout, child.stderr).not.toBe("");
  const result = JSON.parse(child.stdout);
  expect(result.events.slice(0, 2)).toEqual([
    ["opened", w.repo],
    ["opened", other],
  ]);
  expect(
    result.events.filter(([event]: [string]) => event === "observed"),
  ).toHaveLength(2);
  const firstObservation = result.events.findIndex(
    ([event]: [string]) => event === "observed",
  );
  expect(result.events.slice(2, firstObservation)).toEqual([
    [
      "configured",
      expect.arrayContaining([
        "sample/first",
        "sample/second",
        "queue-state:todo",
      ]),
    ],
    [
      "configured",
      expect.arrayContaining([
        "sample/first",
        "sample/second",
        "queue-state:todo",
      ]),
    ],
    ["queue", "factory"],
    ["queue", "factory"],
  ]);
  expect(result.receipt.repos).toHaveLength(2);
  expect(
    result.receipt.repos.every((repo: { defect?: unknown }) => repo.defect),
  ).toBe(true);
});
