/**
 * The Notion store against a local fake of the Notion API: the conformance
 * suite, `init` and `check`, one page per change with its properties as a
 * view of the events, a status changed by hand, repair, the cache, paging,
 * retries, and a repository reflecting into a database `init` created.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, tsArgv } from "../../resolve-review-comments/scripts/lib/proc.ts";
import { eventText, type ReflectionEvent } from "../scripts/lib/events.ts";
import {
  EXIT,
  runStore,
  type StoreResult,
} from "../scripts/lib/store-client.ts";
import {
  runConformance,
  sampleDecision,
  sampleFinding,
} from "../scripts/store-contract.ts";
import { type Block, FakeNotion } from "./notion-fake.ts";
import { finding, Machine } from "./scratch.ts";

const NOTION_STORE = join(import.meta.dir, "..", "scripts", "notion-store.ts");
const REFLECT = join(import.meta.dir, "..", "scripts");
const REVIEW = join(
  import.meta.dir,
  "..",
  "..",
  "review-reflections",
  "scripts",
);

let dir: string;
let fake: FakeNotion;
let env: Record<string, string>;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "reflect-notion-")));
  fake = new FakeNotion();
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !key.startsWith("NOTION_") &&
      !key.startsWith("JIG_NOTION_")
    )
      base[key] = value;
  env = fake.env({ ...base, JIG_HOME: join(dir, "jig-home") });
});
afterEach(() => {
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

const ID = (n: number): string =>
  `20261012T150405Z-${n.toString(16).padStart(16, "0")}`;

async function init(
  environment = env,
): Promise<{ database: string; out: StoreResult }> {
  const parent = fake.addParentPage();
  const r = await run(tsArgv(NOTION_STORE, ["init", "--parent", parent]), {
    env: environment,
    timeoutSec: 60,
  });
  const out = { code: r.code, stdout: r.stdout, stderr: r.stderr };
  const database = /database: (\S+)/.exec(r.stdout)?.[1] ?? "";
  return { database, out };
}

function command(database: string): string[] {
  return tsArgv(NOTION_STORE, ["--database", database]);
}

function store(
  database: string,
  op: Parameters<typeof runStore>[1],
  input = "",
  environment = env,
): Promise<StoreResult> {
  return runStore(command(database), op, input, 60, environment);
}

/** `repair`, which only the Notion store has. */
function repairStore(database: string) {
  return run(tsArgv(NOTION_STORE, ["--database", database, "repair"]), {
    env,
    timeoutSec: 60,
  });
}

function jsonl(events: readonly ReflectionEvent[]): string {
  return `${events.map(eventText).join("\n")}\n`;
}

async function append(database: string, events: readonly ReflectionEvent[]) {
  const r = await store(database, "append", jsonl(events));
  if (r.code !== 0) throw new Error(`append exited ${r.code}: ${r.stderr}`);
  return JSON.parse(r.stdout) as { stored: Array<{ id: string; ref: string }> };
}

async function listed(database: string): Promise<string[]> {
  const r = await store(database, "list");
  if (r.code !== 0) throw new Error(`list exited ${r.code}: ${r.stderr}`);
  return r.stdout.split("\n").filter((line) => line !== "");
}

async function notices(
  database: string,
): Promise<Array<Record<string, unknown>>> {
  const r = await store(database, "diagnose");
  if (r.code !== 0) throw new Error(`diagnose exited ${r.code}: ${r.stderr}`);
  return r.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The text of the record a toggle holds. */
function recordText(toggle: { nested: Block[] }): string {
  const rich = toggle.nested[0]?.content.rich_text;
  return Array.isArray(rich)
    ? rich
        .map((item) => String((item as { plain_text: unknown }).plain_text))
        .join("")
    : "";
}

describe("the Notion store", () => {
  it("passes the conformance suite against a database init created", async () => {
    const { database, out } = await init();
    expect(out.code).toBe(0);
    const results = await runConformance(command(database), 60, env);
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.length).toBeGreaterThan(10);
  }, 120_000);

  it("creates the database with its properties and views, and prints the setting", async () => {
    const { database, out } = await init();
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("store: notion");
    expect(out.stdout).toContain(`database: ${database}`);
    const source = [...fake.dataSources.values()][0];
    expect([...(source?.properties.keys() ?? [])]).toEqual(
      expect.arrayContaining([
        "Name",
        "Status",
        "Severity",
        "Classes",
        "Repository",
        "Last reflected",
      ]),
    );
    const views = [...fake.views.values()].map((view) => view.name);
    expect(views.sort()).toEqual(["All changes", "By status", "Inbox"]);
    expect((await store(database, "check")).stdout).toBe('{"ok":true}\n');
  });

  it("checks a missing or refused token, a database it cannot see, one init did not create, and missing properties", async () => {
    const { database } = await init();
    const { NOTION_TOKEN: _, ...noToken } = env;
    const without = JSON.parse(
      (await store(database, "check", "", noToken)).stdout,
    );
    expect(without).toMatchObject({
      ok: false,
      reason: "NOTION_TOKEN is not set",
    });
    expect(without.fix).toContain("NOTION_TOKEN");

    const refused = await store(database, "check", "", {
      ...env,
      NOTION_TOKEN: "wrong",
    });
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false });

    const unseen = JSON.parse((await store("0".repeat(32), "check")).stdout);
    expect(unseen.reason).toContain("cannot see");
    expect(unseen.fix).toContain("Connections");

    const foreign = JSON.parse(
      (await store(fake.addForeignDatabase(), "check")).stdout,
    );
    expect(foreign.reason).toContain("not created by notion-store.ts init");

    [...fake.dataSources.values()][0]?.properties.delete("Severity");
    const lacking = JSON.parse((await store(database, "check")).stdout);
    expect(lacking.reason).toContain("Severity (select)");
  });

  it("reads an unreachable Notion, or a missing token, as unavailable", async () => {
    const { database } = await init();
    const { NOTION_TOKEN: _, ...noToken } = env;
    expect((await store(database, "list", "", noToken)).code).toBe(
      EXIT.unavailable,
    );
    expect(
      (await store(database, "list", "", { ...env, NOTION_TOKEN: "wrong" }))
        .code,
    ).toBe(EXIT.unavailable);
    const port = fake.server.port;
    fake.stop();
    const r = await store(database, "list", "", {
      ...env,
      JIG_NOTION_API_URL: `http://127.0.0.1:${port}`,
    });
    expect(r.code).toBe(EXIT.unavailable);
  });

  it("keeps one page per change, with the findings as text and the properties computed from the events", async () => {
    const { database } = await init();
    const a = {
      ...sampleFinding(ID(1), "The setup step assumed a database"),
      severity: "medium" as const,
    };
    const b = {
      ...sampleFinding(
        ID(2),
        "A second finding about it",
        "2026-10-13T09:00:00Z",
      ),
      change: a.change,
      severity: "high" as const,
      class: "instruction-missing-precondition",
    };
    await append(database, [a]);
    await append(database, [b]);
    const pages = fake.pagesOf(database);
    expect(pages.length).toBe(1);
    const page = pages[0] as (typeof pages)[number];
    expect(fake.shown(page, "Name")).toBe(
      `[example.invalid/store-contract] ${a.change.branch}: The setup step assumed a database`,
    );
    expect(fake.shown(page, "Status")).toBe("Inbox");
    expect(fake.shown(page, "Severity")).toBe("High");
    expect(fake.shown(page, "Classes")).toEqual([
      "store-contract-sample",
      "instruction-missing-precondition",
    ]);
    expect(fake.shown(page, "Components")).toEqual(["jig/reflect"]);
    expect(fake.shown(page, "Repository")).toBe(
      "example.invalid/store-contract",
    );
    expect(fake.shown(page, "Branch")).toBe(a.change.branch);
    expect(fake.shown(page, "First reflected")).toBe(a.at);
    expect(fake.shown(page, "Last reflected")).toBe(b.at);
    const tree = fake.tree(page.id);
    expect(tree.filter((block) => block.type === "heading_3").length).toBe(2);
    expect(tree.filter((block) => block.type === "callout").length).toBe(2);
    const records = tree.filter((block) => block.type === "toggle");
    expect(records.map((block) => block.nested[0]?.type)).toEqual([
      "code",
      "code",
    ]);
  });

  it("adds a decision as a review note under its finding and recomputes Status", async () => {
    const { database } = await init();
    const a = sampleFinding(ID(1), "first");
    const b = { ...sampleFinding(ID(2), "second"), change: a.change };
    await append(database, [a, b]);
    await append(database, [sampleDecision(ID(3), a.id, "not actionable")]);
    const page = fake.pagesOf(database)[0] as ReturnType<
      FakeNotion["pagesOf"]
    >[number];
    const tree = fake.tree(page.id);
    const order = tree
      .filter((block) => block.type === "toggle")
      .map((block) => (JSON.parse(recordText(block)) as { id: string }).id);
    expect(order).toEqual([a.id, ID(3), b.id]);
    expect(fake.shown(page, "Status")).toBe("Inbox");
    await append(database, [sampleDecision(ID(4), b.id, "already fixed")]);
    expect(fake.shown(page, "Status")).toBe("Dismissed");
  });

  it("reads only the records: editing the prose changes nothing list returns", async () => {
    const { database } = await init();
    const a = sampleFinding(ID(1), "first");
    await append(database, [a]);
    const page = fake.pagesOf(database)[0] as ReturnType<
      FakeNotion["pagesOf"]
    >[number];
    for (const block of fake.tree(page.id))
      if (block.type === "paragraph")
        fake.editText(block, "rewritten by a person");
    expect(await listed(database)).toEqual([eventText(a)]);
  });

  it("refuses a record that is not an event, naming its block", async () => {
    const { database } = await init();
    await append(database, [sampleFinding(ID(1), "first")]);
    const page = fake.pagesOf(database)[0] as ReturnType<
      FakeNotion["pagesOf"]
    >[number];
    const toggle = fake.tree(page.id).find((block) => block.type === "toggle");
    const code = toggle?.nested[0];
    if (toggle === undefined || code === undefined)
      throw new Error("no record");
    fake.editText(code, '{"v":1}');
    const r = await store(database, "list");
    expect(r.code).toBe(EXIT.failed);
    expect(r.stderr).toContain(`${page.url}#${toggle.id.replaceAll("-", "")}`);
    expect(r.stderr).toContain("not a reflection event");
  });

  it("keeps a Status changed by hand, reports it, and lets it go once a decision agrees", async () => {
    const { database } = await init();
    const a = sampleFinding(ID(1), "first");
    const b = { ...sampleFinding(ID(2), "second"), change: a.change };
    await append(database, [a, b]);
    const page = fake.pagesOf(database)[0] as ReturnType<
      FakeNotion["pagesOf"]
    >[number];
    fake.setSelect(page, "Status", "Deferred");
    await append(database, [sampleDecision(ID(3), a.id, "a reason")]);
    expect(fake.shown(page, "Status")).toBe("Deferred");
    expect(fake.shown(page, "Computed status")).toBe("Inbox");
    expect(await notices(database)).toEqual([
      expect.objectContaining({
        kind: "status-edited",
        ref: page.url,
        shown: "Deferred",
        computed: "Inbox",
      }),
    ]);
    const repaired = await repairStore(database);
    expect(JSON.parse(repaired.stdout).status_kept).toEqual([
      { ref: page.url, shown: "Deferred", computed: "Inbox" },
    ]);
    expect(fake.shown(page, "Status")).toBe("Deferred");
    await append(database, [
      {
        ...sampleDecision(
          ID(4),
          a.id,
          "deferred, as set in Notion",
          "2026-10-13T09:00:00Z",
        ),
        decision: "deferred" as const,
      },
      {
        ...sampleDecision(ID(5), b.id, "deferred, as set in Notion"),
        decision: "deferred" as const,
      },
    ]);
    expect(await notices(database)).toEqual([]);
    // Agreeing again, Status follows the events.
    await append(database, [
      sampleDecision(ID(6), b.id, "now dismissed", "2026-10-14T09:00:00Z"),
    ]);
    expect(fake.shown(page, "Status")).toBe("Dismissed");
  });

  it("stores the events when a property write fails, and repair recomputes the properties", async () => {
    const { database } = await init();
    const a = sampleFinding(ID(1), "first");
    await append(database, [a]);
    fake.failNext("PATCH", /^\/v1\/pages\//, 400);
    const r = await store(
      database,
      "append",
      jsonl([sampleDecision(ID(2), a.id, "a reason")]),
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("repair");
    const page = fake.pagesOf(database)[0] as ReturnType<
      FakeNotion["pagesOf"]
    >[number];
    expect(fake.shown(page, "Status")).toBe("Inbox");
    expect((await listed(database)).length).toBe(2);
    expect((await repairStore(database)).code).toBe(0);
    expect(fake.shown(page, "Status")).toBe("Dismissed");
  });

  it("recomputes the properties when the same events are sent again after a property write failed", async () => {
    const { database } = await init();
    const a = sampleFinding(ID(1), "first");
    await append(database, [a]);
    const decision = sampleDecision(ID(2), a.id, "a reason");
    fake.failNext("PATCH", /^\/v1\/pages\//, 400);
    expect((await store(database, "append", jsonl([decision]))).code).toBe(0);
    const page = fake.pagesOf(database)[0] as ReturnType<
      FakeNotion["pagesOf"]
    >[number];
    expect(fake.shown(page, "Status")).toBe("Inbox");
    await append(database, [decision]);
    expect(fake.shown(page, "Status")).toBe("Dismissed");
    expect(await listed(database)).toHaveLength(2);
  });

  it("carries a settled id conflict to the properties of every page holding a copy", async () => {
    const { database } = await init();
    const a = {
      ...sampleFinding(ID(1), "one writer"),
      class: "class-from-one",
    };
    const other = {
      ...sampleFinding(ID(9), "unused"),
      id: a.id,
      title: "another writer",
      class: "class-from-another",
    };
    // The winning copy is written second, so the page holding the losing
    // copy is not the one the append writes to.
    const [loser, winner] =
      eventText(a) < eventText(other) ? [other, a] : [a, other];
    await append(database, [loser]);
    await append(database, [winner]);
    expect(fake.pagesOf(database).length).toBe(2);
    for (const page of fake.pagesOf(database))
      expect(fake.shown(page, "Classes")).toEqual([winner.class]);
    expect((await repairStore(database)).code).toBe(0);
    for (const page of fake.pagesOf(database))
      expect(fake.shown(page, "Classes")).toEqual([winner.class]);
    const conflict = (await notices(database)).find(
      (n) => n.kind === "id-conflict",
    );
    expect(conflict?.copies).toHaveLength(2);
  });

  it("recomputes every page a failed property write left behind when the events are sent again", async () => {
    const { database } = await init();
    const a = sampleFinding(ID(1), "one writer");
    const other = {
      ...sampleFinding(ID(9), "unused"),
      id: a.id,
      title: "another writer",
    };
    await append(database, [a]);
    await append(database, [other]);
    const pages = fake.pagesOf(database);
    expect(pages.length).toBe(2);
    // The decision is written to one of the two pages; both writes fail.
    for (const page of pages)
      fake.failNext("PATCH", new RegExp(`^/v1/pages/${page.id}$`), 400);
    const decision = sampleDecision(ID(2), a.id, "a reason");
    expect((await store(database, "append", jsonl([decision]))).code).toBe(0);
    for (const page of pages) expect(fake.shown(page, "Status")).toBe("Inbox");
    await append(database, [decision]);
    for (const page of pages)
      expect(fake.shown(page, "Status")).toBe("Dismissed");
  });

  it("catches up a page a failed property write left behind on the next append of any event", async () => {
    const { database } = await init();
    const a = sampleFinding(ID(1), "first");
    await append(database, [a]);
    fake.failNext("PATCH", /^\/v1\/pages\//, 400);
    await append(database, [sampleDecision(ID(2), a.id, "a reason")]);
    const page = fake.pagesOf(database)[0] as ReturnType<
      FakeNotion["pagesOf"]
    >[number];
    expect(fake.shown(page, "Status")).toBe("Inbox");
    await append(database, [sampleFinding(ID(3), "unrelated")]);
    expect(fake.shown(page, "Status")).toBe("Dismissed");
  });

  it("counts one session for one setup, whichever fields were stated and in whatever order the skills came", async () => {
    const { database } = await init();
    const a = sampleFinding(ID(1), "first");
    const setup = { ...a.session, skills: ["reflect", "drive-pr"], stated: [] };
    const b = {
      ...sampleFinding(ID(2), "second"),
      change: a.change,
      session: { ...setup, skills: ["drive-pr", "reflect"], stated: ["model"] },
    };
    await append(database, [{ ...a, session: setup }, b]);
    const page = fake.pagesOf(database)[0] as ReturnType<
      FakeNotion["pagesOf"]
    >[number];
    expect(fake.shown(page, "Sessions")).toBe(1);
  });

  it("recomputes the page of the finding a decision's previous winning copy was about", async () => {
    const { database } = await init();
    const x = sampleFinding(ID(1), "first");
    const y = sampleFinding(ID(2), "second");
    const dx = sampleDecision(ID(5), x.id, "a reason");
    const dy = { ...dx, finding: y.id };
    // The copy written last wins the id conflict, and is about the other finding.
    const [loser, winner] = eventText(dx) < eventText(dy) ? [dy, dx] : [dx, dy];
    const [dismissed, other] = loser.finding === x.id ? [x, y] : [y, x];
    await append(database, [loser]);
    await append(database, [dismissed, other]);
    const pageOf = (title: string) =>
      fake
        .pagesOf(database)
        .find((page) =>
          String(fake.shown(page, "Name")).endsWith(title),
        ) as ReturnType<FakeNotion["pagesOf"]>[number];
    expect(fake.shown(pageOf(dismissed.title), "Status")).toBe("Dismissed");
    await append(database, [winner]);
    expect(fake.shown(pageOf(dismissed.title), "Status")).toBe("Inbox");
    expect(fake.shown(pageOf(other.title), "Status")).toBe("Dismissed");
  });

  it("merges two pages for one change, and writes later events to the older", async () => {
    const { database } = await init();
    const a = sampleFinding(ID(1), "first");
    const b = { ...sampleFinding(ID(2), "second"), change: a.change };
    const c = { ...sampleFinding(ID(3), "third"), change: a.change };
    fake.now = () => new Date("2026-10-12T10:00:00Z");
    await append(database, [a]);
    const older = fake.pagesOf(database)[0] as ReturnType<
      FakeNotion["pagesOf"]
    >[number];
    // A second session that did not see the first page yet creates its own.
    older.inTrash = true;
    fake.now = () => new Date("2026-10-12T10:01:00Z");
    await append(database, [b]);
    older.inTrash = false;
    expect(fake.pagesOf(database).length).toBe(2);
    expect((await listed(database)).sort()).toEqual(
      [eventText(a), eventText(b)].sort(),
    );
    await append(database, [c]);
    const records = fake
      .tree(older.id)
      .filter((block) => block.type === "toggle").length;
    expect(records).toBe(2);
  });

  it("re-reads only the pages edited since the last list", async () => {
    const { database } = await init();
    fake.now = () => new Date(Date.now() - 60 * 60_000);
    const a = sampleFinding(ID(1), "first");
    const b = sampleFinding(ID(2), "second");
    await append(database, [a, b]);
    await listed(database);
    const before = fake.countRequests("GET", /^\/v1\/blocks\//);
    expect(await listed(database)).toHaveLength(2);
    expect(fake.countRequests("GET", /^\/v1\/blocks\//)).toBe(before);
    fake.now = () => new Date(Date.now() - 50 * 60_000);
    await append(database, [sampleDecision(ID(3), a.id, "a reason")]);
    const afterAppend = fake.countRequests("GET", /^\/v1\/blocks\//);
    expect(await listed(database)).toHaveLength(3);
    // One page changed: its children and its two records are read again.
    expect(fake.countRequests("GET", /^\/v1\/blocks\//) - afterAppend).toBe(3);
  });

  it("keeps the pages a failed read got through, so the next read goes on from there", async () => {
    const { database } = await init();
    fake.now = () => new Date(Date.now() - 60 * 60_000);
    await append(database, [sampleFinding(ID(1), "first")]);
    await append(database, [sampleFinding(ID(2), "second")]);
    // The query lists the newest page first, so the older one is read last.
    const older = fake.pagesOf(database)[0]?.id;
    const failing = new RegExp(`^/v1/blocks/${older}/children`);
    fake.failNext("GET", failing, 400);
    // A machine that has never read the store.
    rmSync(join(dir, "jig-home", "cache"), { recursive: true, force: true });
    expect((await store(database, "list")).code).toBe(1);
    const before = fake.countRequests("GET", /^\/v1\/blocks\//);
    expect(await listed(database)).toHaveLength(2);
    const read = fake.countRequests("GET", /^\/v1\/blocks\//) - before;
    // Only the older page: its children and its record.
    expect(read).toBe(2);
  });

  it("does not cache a page edited within the last minutes, whose time Notion keeps to the minute", async () => {
    const { database } = await init();
    await append(database, [sampleFinding(ID(1), "first")]);
    await listed(database);
    const before = fake.countRequests("GET", /^\/v1\/blocks\//);
    await listed(database);
    expect(fake.countRequests("GET", /^\/v1\/blocks\//)).toBeGreaterThan(
      before,
    );
  });

  it("reads every page of every listing", async () => {
    const { database } = await init();
    const events = [1, 2, 3, 4, 5].map((n) =>
      sampleFinding(ID(n), `finding ${n}`),
    );
    await append(database, events);
    const a = events[0] as ReflectionEvent;
    await append(
      database,
      [1, 2, 3].map((n) =>
        sampleDecision(
          ID(10 + n),
          a.id,
          `decision ${n}`,
          `2026-10-1${n}T09:00:00Z`,
        ),
      ),
    );
    fake.pageSize = 2;
    expect((await listed(database)).length).toBe(8);
  });

  it("waits as Retry-After says and tries again", async () => {
    const { database } = await init();
    fake.failNext("POST", /\/query$/, 429, 1);
    const started = Date.now();
    expect((await store(database, "list")).code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });

  it("refuses an operation named like an object's built-in", async () => {
    const { database } = await init();
    for (const op of ["toString", "constructor", "__proto__"]) {
      const r = await run(tsArgv(NOTION_STORE, ["--database", database, op]), {
        env,
        timeoutSec: 60,
      });
      expect(r.code).toBe(2);
    }
  });

  it("retries a server overload (529)", async () => {
    const { database } = await init();
    fake.failNext("POST", /\/query$/, 529, 0);
    expect((await store(database, "list")).code).toBe(0);
  });

  it("retries a query after a server error, since a query only reads", async () => {
    const { database } = await init();
    fake.failNext("POST", /\/query$/, 503, 0);
    expect((await store(database, "list")).code).toBe(0);
  });

  it("reads a wait longer than a minute as unavailable, without retrying early", async () => {
    const { database } = await init();
    fake.failNext("POST", /\/query$/, 429, 120);
    const before = fake.countRequests("POST", /\/query/);
    const r = await store(database, "list");
    expect(r.code).toBe(3);
    expect(fake.countRequests("POST", /\/query/) - before).toBe(1);
  });

  it("does not send a write again after a server error, and a second append finishes it", async () => {
    const { database } = await init();
    const a = sampleFinding(ID(1), "first");
    fake.failNext("POST", /^\/v1\/pages$/, 500);
    const r = await store(database, "append", jsonl([a]));
    expect(r.code).toBe(3);
    expect(fake.countRequests("POST", /^\/v1\/pages$/)).toBe(1);
    await append(database, [a]);
    expect(await listed(database)).toEqual([eventText(a)]);
  });

  it("refuses to send the token to a plain-http endpoint on another host", async () => {
    const { database } = await init();
    const r = await store(database, "list", "", {
      ...env,
      JIG_NOTION_API_URL: "http://example.invalid",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("https");
  });

  it("splits an append whose blocks are larger than one request takes", async () => {
    const { database } = await init();
    const a = {
      ...sampleFinding(ID(1), "first"),
      description: "x".repeat(100_000),
    };
    const more = [2, 3].map((n) => ({
      ...sampleFinding(ID(n), `finding ${n}`),
      change: a.change,
      description: "y".repeat(100_000),
    }));
    await append(database, [a, ...more]);
    expect(fake.pagesOf(database)).toHaveLength(1);
    expect(await listed(database)).toHaveLength(3);
  });

  it("shortens a paragraph made of several long texts to what Notion takes", async () => {
    const { database } = await init();
    const a = sampleFinding(ID(1), "x".repeat(178_201));
    await append(database, [a]);
    expect(await listed(database)).toEqual([eventText(a)]);
  });

  it("shows at most a hundred options in a multi-select", async () => {
    const { database } = await init();
    const a = sampleFinding(ID(1), "first");
    const events = Array.from({ length: 101 }, (_, n) => ({
      ...sampleFinding(ID(n + 1), `finding ${n}`),
      change: a.change,
      class: `class-${n}`,
    }));
    await append(database, events);
    const page = fake.pagesOf(database)[0] as ReturnType<
      FakeNotion["pagesOf"]
    >[number];
    expect(fake.shown(page, "Classes")).toHaveLength(100);
  });

  it("keeps an event longer than one rich text item byte for byte", async () => {
    const { database } = await init();
    const long = {
      ...sampleFinding(ID(1), "long"),
      description: `${"é🙂 ".repeat(1500)}end`,
    };
    await append(database, [long]);
    expect(await listed(database)).toEqual([eventText(long)]);
  });

  it("files a decision about a finding it lacks on its own page", async () => {
    const { database } = await init();
    const orphan = sampleDecision(
      ID(2),
      ID(1),
      "about a finding stored elsewhere",
    );
    await append(database, [orphan]);
    expect(await listed(database)).toEqual([eventText(orphan)]);
    const page = fake.pagesOf(database)[0] as ReturnType<
      FakeNotion["pagesOf"]
    >[number];
    expect(String(fake.shown(page, "Name"))).toContain(
      "decisions about findings",
    );
  });
});

describe("reflecting into Notion", () => {
  it("contributes and reviews with only the database setting and NOTION_TOKEN", async () => {
    const m = new Machine();
    try {
      const machineEnv = fake.env({ ...m.env, JIG_HOME: m.home });
      const { database, out } = await init(machineEnv);
      expect(out.code).toBe(0);
      m.userConfig(
        `reflection:\n  store: notion\n  notion:\n    database: ${database}\n`,
      );
      const repo = m.repository("web", "git@github.com:example/web.git");
      const script = (
        dir: string,
        name: string,
        args: string[],
        stdin?: string,
      ) =>
        run(tsArgv(join(dir, name), args), {
          cwd: repo.root,
          env: machineEnv,
          timeoutSec: 60,
          ...(stdin === undefined ? {} : { stdin }),
        });
      const noted = await script(
        REFLECT,
        "journal.ts",
        ["note"],
        JSON.stringify(finding()),
      );
      expect(noted.stderr).toBe("");
      const id = (JSON.parse(noted.stdout) as { id: string }).id;
      const contributed = await script(REFLECT, "reflect.ts", ["contribute"]);
      expect(contributed.stderr).toBe("");
      expect(contributed.code).toBe(0);
      const stored = JSON.parse(contributed.stdout) as {
        stored: Array<{ id: string; ref: string }>;
      };
      expect(stored.stored.map((s) => s.id)).toEqual([id]);
      expect(stored.stored[0]?.ref).toStartWith("https://www.notion.so/");
      const loaded = await script(REVIEW, "review.ts", ["load"]);
      expect(loaded.code).toBe(0);
      const groups = (
        JSON.parse(loaded.stdout) as {
          groups: Array<{ findings: Array<{ id: string }> }>;
        }
      ).groups;
      expect(groups[0]?.findings[0]?.id).toBe(id);
      const page = fake.pagesOf(database)[0] as ReturnType<
        FakeNotion["pagesOf"]
      >[number];
      expect(fake.shown(page, "Repository")).toBe("github.com/example/web");
    } finally {
      m.cleanup();
    }
  }, 120_000);
});
