/**
 * The Notion store's operations over a database `init` created: reading
 * every event (through a cache of unchanged pages), appending events to
 * their change's page, recomputing the page properties, and reporting what
 * disagrees with the events.
 */
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isMapping, jigHome } from "../../../../../shared/config-layers.ts";
import {
  computeState,
  type ComputedState,
  type DecisionEvent,
  distinctById,
  type FindingEvent,
  idConflicts,
  parseEvent,
  type ReflectionEvent,
  type Session,
} from "../events.ts";
import {
  changeKey,
  changeKeyOf,
  eventsOn,
  planFindingsFirst,
  winnersOf,
} from "../change-view.ts";
import { NOTION_VERSION, type NotionApi, NotionError } from "./api.ts";
import { compactId } from "./ids.ts";
import {
  type Block,
  decisionBlocks,
  EVENT_CAPTION,
  findingBlocks,
  HIDDEN_PROPERTIES,
  pageProperties,
  plainText,
  PROPERTY,
  PROPERTY_TYPES,
  propertySchema,
  recordBlock,
  richText,
  sectionHeading,
  sessionCallout,
  shownValue,
  STORE_MARK,
  UNFILED_KEY,
} from "./model.ts";

/** A page or database: its id and the link people open. */
export interface Link {
  id: string;
  url: string;
}

/** The id and link of an object Notion returned. */
function linkOf(object: Record<string, unknown>): Link {
  if (typeof object.id !== "string")
    throw new NotionError(1, "Notion returned an object without an id");
  return {
    id: object.id,
    url:
      typeof object.url === "string"
        ? object.url
        : `https://www.notion.so/${compactId(object.id)}`,
  };
}

// ── The database ────────────────────────────────────────────────────────────

export interface Database {
  id: string;
  dataSourceId: string;
  url: string;
}

/** Why a database cannot be used as a store, and how to fix that. */
export interface Unusable {
  reason: string;
  fix: string;
}

/**
 * The database and its one data source, or why it cannot be used. A
 * database without the store's mark was not created by `init`, and the
 * store does not adopt it.
 */
export async function openDatabase(
  api: NotionApi,
  id: string,
): Promise<Database | Unusable> {
  let database: Record<string, unknown>;
  try {
    database = await api.request("GET", `/v1/databases/${id}`);
  } catch (error) {
    if (
      error instanceof NotionError &&
      (error.status === 404 || error.status === 403)
    )
      return {
        reason: `the integration cannot see the database ${id}`,
        fix: "share the database's page with the integration (the page's ••• menu → Connections), or check reflection.notion.database",
      };
    throw error;
  }
  if (!plainText(database.description).includes(STORE_MARK))
    return {
      reason: `the database ${id} was not created by notion-store.ts init`,
      fix: "create the store's database with `notion-store.ts init --parent <page>` and point reflection.notion.database at it",
    };
  const sources = Array.isArray(database.data_sources)
    ? database.data_sources
    : [];
  const source = sources[0];
  if (
    sources.length !== 1 ||
    !isMapping(source) ||
    typeof source.id !== "string"
  )
    return {
      reason: `the database ${id} has ${sources.length} data sources; the store keeps one`,
      fix: "remove the data sources added after init, or create a new database with init",
    };
  return {
    id,
    dataSourceId: source.id,
    url: typeof database.url === "string" ? database.url : id,
  };
}

/** Properties the data source lacks or holds with another type. */
export async function missingProperties(
  api: NotionApi,
  database: Database,
): Promise<string[]> {
  const source = await api.request(
    "GET",
    `/v1/data_sources/${database.dataSourceId}`,
  );
  const held = isMapping(source.properties) ? source.properties : {};
  return Object.entries(PROPERTY_TYPES)
    .filter(([name, type]) => {
      const property = held[name];
      return !isMapping(property) || property.type !== type;
    })
    .map(([name, type]) => `${name} (${type})`);
}

export function isUnusable(value: Database | Unusable): value is Unusable {
  return "reason" in value;
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** One event's copy, where the page holds it. */
export interface Copy {
  id: string;
  text: string;
  event: ReflectionEvent;
  /** The toggle that holds the record. */
  block: string;
  page: string;
  ref: string;
}

export interface PageRead {
  id: string;
  url: string;
  created: string;
  edited: string;
  key: string | null;
  shown: string | null;
  hidden: string | null;
  /** The digest of the properties last written to it. */
  digest: string | null;
  /** In page order. */
  copies: Copy[];
}

interface CachedPage {
  edited: string;
  copies: Array<{ text: string; block: string }>;
}

interface CacheFile {
  format: 1;
  version: string;
  pages: Record<string, CachedPage>;
}

/**
 * Notion keeps a page's last-edited time to the minute, so a page edited
 * again within the same minute keeps its time. A page is cached only once
 * its time is this far in the past, when no edit can still share it.
 */
const SETTLED_MS = 5 * 60_000;

/**
 * While reading, the cache is saved at most this often, and when a read
 * fails, so a read cut off by its deadline or a failure keeps the pages it
 * read and the next one goes on from there.
 */
const SAVE_EVERY_MS = 10_000;

export function cachePath(database: string): string {
  return join(jigHome(), "cache", "notion", `${compactId(database)}.json`);
}

/** The cache, or an empty one: it is only ever a shortcut to a re-read. */
function loadCache(path: string): CacheFile {
  const empty: CacheFile = { format: 1, version: NOTION_VERSION, pages: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(
        `the Notion store's cache ${path} cannot be read (${error instanceof Error ? error.message : String(error)}); every page is read again`,
      );
    return empty;
  }
  if (
    !isMapping(parsed) ||
    parsed.format !== 1 ||
    parsed.version !== NOTION_VERSION ||
    !isMapping(parsed.pages)
  )
    return empty;
  return parsed as unknown as CacheFile;
}

function saveCache(path: string, cache: CacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, JSON.stringify(cache));
    try {
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  } catch (error) {
    console.error(
      `the Notion store's cache could not be written (${path}): ${error instanceof Error ? error.message : String(error)}; the next run reads every page again`,
    );
  }
}

function blockRef(url: string, block: string): string {
  return `${url}#${compactId(block)}`;
}

function copyOf(page: Link, text: string, block: string): Copy {
  let event: ReflectionEvent;
  try {
    event = parseEvent(text);
  } catch (error) {
    throw new NotionError(
      1,
      `${blockRef(page.url, block)} holds a record that is not a reflection event: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    id: event.id,
    text,
    event,
    block,
    page: page.id,
    ref: blockRef(page.url, block),
  };
}

/** Every record on a page: the event code blocks inside its toggles. */
async function readRecords(api: NotionApi, page: Link): Promise<Copy[]> {
  const copies: Copy[] = [];
  for (const block of await api.all("GET", `/v1/blocks/${page.id}/children`)) {
    if (
      !isMapping(block) ||
      block.type !== "toggle" ||
      block.has_children !== true ||
      typeof block.id !== "string"
    )
      continue;
    for (const child of await api.all(
      "GET",
      `/v1/blocks/${block.id}/children`,
    )) {
      if (!isMapping(child) || child.type !== "code" || !isMapping(child.code))
        continue;
      if (plainText(child.code.caption) !== EVENT_CAPTION) continue;
      copies.push(copyOf(page, plainText(child.code.rich_text), block.id));
    }
  }
  return copies;
}

const QUERIED = [
  PROPERTY.key,
  PROPERTY.status,
  PROPERTY.computed,
  PROPERTY.digest,
];

/** A page's records: from the cache when its last-edited time is the cached one. */
async function recordsOf(
  api: NotionApi,
  page: Link,
  edited: string,
  cached: CachedPage | undefined,
): Promise<Copy[]> {
  if (cached !== undefined && edited !== "" && cached.edited === edited)
    return cached.copies.map((copy) => copyOf(page, copy.text, copy.block));
  return readRecords(api, page);
}

/** One page of the database's query, with its records. */
async function readPage(
  api: NotionApi,
  result: Record<string, unknown>,
  cache: CacheFile,
): Promise<PageRead> {
  const page = linkOf(result);
  const edited = String(result.last_edited_time ?? "");
  const properties = isMapping(result.properties) ? result.properties : {};
  return {
    ...page,
    created: String(result.created_time ?? ""),
    edited,
    key: shownValue(properties[PROPERTY.key]),
    shown: shownValue(properties[PROPERTY.status]),
    hidden: shownValue(properties[PROPERTY.computed]),
    digest: shownValue(properties[PROPERTY.digest]),
    copies: await recordsOf(api, page, edited, cache.pages[page.id]),
  };
}

/**
 * Every page and every record in the database. Pages whose last-edited
 * time is the cached one are not read again.
 */
export async function readStore(
  api: NotionApi,
  database: Database,
  now = Date.now(),
): Promise<PageRead[]> {
  const query = QUERIED.map(
    (name) => `filter_properties=${encodeURIComponent(name)}`,
  ).join("&");
  const results = await api.all(
    "POST",
    `/v1/data_sources/${database.dataSourceId}/query?${query}`,
  );
  const path = cachePath(database.id);
  const cache = loadCache(path);
  const pages: PageRead[] = [];
  const next: CacheFile = { format: 1, version: NOTION_VERSION, pages: {} };
  let saved = Date.now();
  let unsaved = false;
  try {
    for (const result of results) {
      if (!isMapping(result)) continue;
      const page = await readPage(api, result, cache);
      pages.push(page);
      if (page.edited === "" || Date.parse(page.edited) >= now - SETTLED_MS)
        continue;
      const entry: CachedPage = {
        edited: page.edited,
        copies: page.copies.map(({ text, block }) => ({ text, block })),
      };
      next.pages[page.id] = entry;
      if (cache.pages[page.id]?.edited === page.edited) continue;
      // Read from Notion: kept beside the pages not reached yet.
      cache.pages[page.id] = entry;
      unsaved = true;
      if (Date.now() - saved >= SAVE_EVERY_MS) {
        saveCache(path, cache);
        saved = Date.now();
        unsaved = false;
      }
    }
  } catch (error) {
    if (unsaved) saveCache(path, cache);
    throw error;
  }
  saveCache(path, next);
  return pages;
}

/** Older first: later writes for a change go to its oldest page. */
function byAge(a: PageRead, b: PageRead): number {
  if (a.created !== b.created) return a.created < b.created ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

export function allCopies(pages: readonly PageRead[]): Copy[] {
  return pages.flatMap((page) => page.copies);
}

// ── Properties ──────────────────────────────────────────────────────────────

export interface Synced {
  page: string;
  ref: string;
  /** Status was changed by hand, so it was left as the person set it. */
  kept: boolean;
  shown: string | null;
  computed: string;
}

/**
 * Recompute a page's properties from its events. A Status that differs
 * from the hidden one the store last wrote was changed by hand: it is left
 * as it is, and the rest is updated.
 */
export async function syncProperties(
  api: NotionApi,
  page: Link,
  key: string,
  events: readonly ReflectionEvent[],
  state: ComputedState,
): Promise<Synced> {
  const fresh = await api.request("GET", `/v1/pages/${page.id}`);
  const held = isMapping(fresh.properties) ? fresh.properties : {};
  const shown = shownValue(held[PROPERTY.status]);
  const hidden = shownValue(held[PROPERTY.computed]);
  const { properties, status } = pageProperties(key, events, state);
  const kept = hidden !== null && shown !== hidden;
  if (!kept) properties[PROPERTY.status] = { select: { name: status } };
  await api.request("PATCH", `/v1/pages/${page.id}`, { properties });
  return { page: page.id, ref: page.url, kept, shown, computed: status };
}

function idsOn(page: PageRead): string[] {
  return page.copies.map((copy) => copy.id);
}

// ── Appending ───────────────────────────────────────────────────────────────

interface Group {
  finding: string | null;
  session: Session;
  blocks: Block[];
}

interface Target {
  key: string;
  page: PageRead | null;
  /** Created for this append: its id and link once created. */
  created: Link | null;
  groups: Group[];
  /** Blocks to insert after an existing block, by that block's id. */
  inserts: Map<string, Block[]>;
  events: ReflectionEvent[];
}

function recordOf(event: ReflectionEvent, text: string): Block {
  const block = recordBlock(text);
  if (block === null)
    throw new NotionError(
      1,
      `event ${event.id} is too long to keep in one Notion code block`,
    );
  return block;
}

/** The section a write adds at the end of a page. */
function sectionBlocks(groups: readonly Group[], now: string): Block[] {
  const blocks: Block[] = [sectionHeading(now)];
  let session: string | null = null;
  for (const group of groups) {
    const shown = JSON.stringify(group.session);
    if (shown !== session) blocks.push(sessionCallout(group.session));
    session = shown;
    blocks.push(...group.blocks);
  }
  return blocks;
}

const MAX_CHILDREN = 100;

/**
 * Notion takes requests of up to 500 KB; the blocks of one request stay
 * under this, leaving room for the rest of the body.
 */
const MAX_BATCH_BYTES = 450_000;

/** Blocks in request-sized batches: at most 100, and under the size limit. */
function batches(blocks: readonly Block[]): Block[][] {
  const out: Block[][] = [];
  let batch: Block[] = [];
  let bytes = 0;
  for (const block of blocks) {
    const size = Buffer.byteLength(JSON.stringify(block)) + 1;
    if (size > MAX_BATCH_BYTES)
      throw new NotionError(
        1,
        `a block of ${size} bytes is larger than one Notion request takes`,
      );
    if (batch.length === MAX_CHILDREN || bytes + size > MAX_BATCH_BYTES) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(block);
    bytes += size;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/** The id of the last block an append added. */
function lastAdded(answer: Record<string, unknown>, parent: string): string {
  const added = Array.isArray(answer.results) ? answer.results : [];
  const last = added.at(-1);
  if (isMapping(last) && typeof last.id === "string") return last.id;
  throw new NotionError(
    1,
    `Notion did not say which blocks it added to ${parent}`,
  );
}

/** Add blocks under `parent`: at the end, or after the block `after`. */
async function appendChildren(
  api: NotionApi,
  parent: string,
  blocks: readonly Block[],
  after: string | null = null,
): Promise<void> {
  let anchor = after;
  for (const children of batches(blocks)) {
    const answer = await api.request("PATCH", `/v1/blocks/${parent}/children`, {
      children,
      position:
        anchor === null
          ? { type: "end" }
          : { type: "after_block", after_block: { id: anchor } },
    });
    // The next chunk goes after the last block this one added.
    if (anchor !== null) anchor = lastAdded(answer, parent);
  }
}

export interface Receipt {
  id: string;
  ref: string;
}

export interface AppendResult {
  stored: Receipt[];
  /** Pages whose properties could not be recomputed; `repair` does it later. */
  propertyFailures: string[];
}

type Home = { text: string; page: PageRead } | { text: string; target: Target };

/** The last record about a finding on a page: where a decision goes. */
function anchorFor(page: PageRead, finding: string): Copy | undefined {
  return [...page.copies]
    .reverse()
    .find(
      (copy) =>
        copy.id === finding ||
        (copy.event.type === "decision" && copy.event.finding === finding),
    );
}

/** Where each event of one append goes: which page, and where on it. */
class AppendPlan {
  readonly targets = new Map<string, Target>();
  readonly receipts: Array<Receipt | { id: string; target: Target }> = [];
  private readonly held = new Map<string, Copy>();
  private readonly byKey = new Map<string, PageRead[]>();
  /** Each finding's home: the page of the copy `list` returns, or a target. */
  private readonly home = new Map<string, Home>();
  private readonly written = new Map<string, Target>();

  constructor(pages: readonly PageRead[]) {
    for (const page of [...pages].sort(byAge)) {
      if (page.key !== null)
        this.byKey.set(page.key, [...(this.byKey.get(page.key) ?? []), page]);
      for (const copy of page.copies) {
        this.held.set(copy.text, copy);
        if (copy.event.type === "finding")
          this.settle(copy.id, { text: copy.text, page });
      }
    }
  }

  /** Plan one event; an event already stored, or already planned, is not written twice. */
  add(event: ReflectionEvent, text: string): void {
    const copy = this.held.get(text);
    if (copy !== undefined) {
      this.receipts.push({ id: event.id, ref: copy.ref });
      return;
    }
    const target =
      this.written.get(text) ??
      (event.type === "finding"
        ? this.addFinding(event, text)
        : this.addDecision(event, text));
    if (!this.written.has(text)) target.events.push(event);
    this.written.set(text, target);
    this.receipts.push({ id: event.id, target });
  }

  private settle(id: string, home: Home): void {
    const known = this.home.get(id);
    if (known === undefined || home.text < known.text) this.home.set(id, home);
  }

  private targetFor(
    key: string,
    page = this.byKey.get(key)?.[0] ?? null,
  ): Target {
    const id = page?.id ?? `new:${key}`;
    const known = this.targets.get(id);
    if (known !== undefined) return known;
    const target: Target = {
      key,
      page,
      created: null,
      groups: [],
      inserts: new Map(),
      events: [],
    };
    this.targets.set(id, target);
    return target;
  }

  private addFinding(event: FindingEvent, text: string): Target {
    const target = this.targetFor(changeKey(event));
    target.groups.push({
      finding: event.id,
      session: event.session,
      blocks: [...findingBlocks(event), recordOf(event, text)],
    });
    this.settle(event.id, { text, target });
    return target;
  }

  /** Under its finding: in this append's section, or after its last record. */
  private addDecision(event: DecisionEvent, text: string): Target {
    const blocks = [...decisionBlocks(event), recordOf(event, text)];
    const loose = { finding: null, session: event.session, blocks };
    const home = this.home.get(event.finding);
    if (home === undefined) {
      const target = this.targetFor(UNFILED_KEY);
      target.groups.push(loose);
      return target;
    }
    if ("target" in home) {
      const group = home.target.groups.find((g) => g.finding === event.finding);
      if (group === undefined) home.target.groups.push(loose);
      else group.blocks.push(...blocks);
      return home.target;
    }
    const target = this.targetFor(
      home.page.key ?? pageKeyOf(home.page),
      home.page,
    );
    const anchor = anchorFor(home.page, event.finding);
    if (anchor === undefined) target.groups.push(loose);
    else
      target.inserts.set(anchor.block, [
        ...(target.inserts.get(anchor.block) ?? []),
        ...blocks,
      ]);
    return target;
  }
}

/** Write one target's blocks: a new page, or inserts and a section. */
async function writeTarget(
  api: NotionApi,
  database: Database,
  target: Target,
  stamp: string,
): Promise<void> {
  const section =
    target.groups.length === 0 ? [] : sectionBlocks(target.groups, stamp);
  if (target.page !== null) {
    for (const [anchor, blocks] of target.inserts)
      await appendChildren(api, target.page.id, blocks, anchor);
    if (section.length > 0) await appendChildren(api, target.page.id, section);
    return;
  }
  const [first = [], ...rest] = batches(section);
  const created = await api.request("POST", "/v1/pages", {
    parent: { type: "data_source_id", data_source_id: database.dataSourceId },
    properties: {
      [PROPERTY.name]: { title: richText(target.key) },
      [PROPERTY.key]: { rich_text: richText(target.key) },
    },
    children: first,
  });
  target.created = linkOf(created);
  await appendChildren(api, target.created.id, rest.flat());
}

/** A page whose properties an append recomputes, with the ids it holds. */
interface ToSync {
  page: Link;
  key: string;
  ids: string[];
}

/**
 * The pages whose properties an append writes: the pages it wrote to, and
 * every other page whose properties, computed from the whole store as
 * `list` now returns it, differ from the ones last written to it (their
 * digest, in the hidden *Computed properties*). Comparing with what each
 * page holds, rather than predicting which pages an event reaches, covers a
 * winning copy, a decision, and the page a decision's previous winning copy
 * was about alike, and also catches up a page an earlier property write
 * failed on.
 */
function pagesToSync(
  pages: readonly PageRead[],
  targets: Iterable<Target>,
  copies: ReadonlyArray<{ event: ReflectionEvent; text: string }>,
): ToSync[] {
  const winners = winnersOf(copies);
  const state = computeState([...winners.values()]);
  const out = new Map<string, ToSync>();
  for (const target of targets) {
    const page = (target.page ?? target.created) as Link;
    out.set(page.id, {
      page,
      key: target.key,
      ids: [
        ...(target.page === null ? [] : idsOn(target.page)),
        ...target.events.map((event) => event.id),
      ],
    });
  }
  for (const page of pages) {
    if (out.has(page.id) || page.copies.length === 0) continue;
    const key = page.key ?? pageKeyOf(page);
    const ids = idsOn(page);
    if (
      pageProperties(key, eventsOn(ids, winners), state).digest !== page.digest
    )
      out.set(page.id, { page, key, ids });
  }
  return [...out.values()];
}

/** Recompute pages' properties; the failures, for the caller to report. */
async function syncPages(
  api: NotionApi,
  toSync: readonly ToSync[],
  copies: ReadonlyArray<{ event: ReflectionEvent; text: string }>,
): Promise<string[]> {
  const winners = winnersOf(copies);
  const state = computeState([...winners.values()]);
  const failures: string[] = [];
  for (const { page, key, ids } of toSync) {
    try {
      await syncProperties(api, page, key, eventsOn(ids, winners), state);
    } catch (error) {
      failures.push(
        `${page.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures;
}

/**
 * Append events (already checked) to the pages of their changes. An event
 * whose exact text the store already holds is not written again.
 */
export async function appendEvents(
  api: NotionApi,
  database: Database,
  lines: ReadonlyArray<{ event: ReflectionEvent; text: string }>,
  now = new Date(),
): Promise<AppendResult> {
  const pages = await readStore(api, database, now.getTime());
  const plan = new AppendPlan(pages);
  planFindingsFirst(lines, (event, text) => plan.add(event, text));
  const stamp = `${now.toISOString().slice(0, 19)}Z`;
  for (const target of plan.targets.values())
    await writeTarget(api, database, target, stamp);
  const stored = plan.receipts.map((receipt) =>
    "ref" in receipt
      ? receipt
      : {
          id: receipt.id,
          ref: (receipt.target.page ?? receipt.target.created)?.url ?? "",
        },
  );
  // The properties, from every event as `list` would now return them.
  const copies = [...allCopies(pages), ...lines];
  const propertyFailures = await syncPages(
    api,
    pagesToSync(pages, plan.targets.values(), copies),
    copies,
  );
  return { stored, propertyFailures };
}

// ── Repair and diagnose ─────────────────────────────────────────────────────

/** Recompute every page's properties from the events as `list` returns them. */
export async function repair(
  api: NotionApi,
  database: Database,
): Promise<{ synced: Synced[]; failures: string[] }> {
  const pages = await readStore(api, database);
  const winners = winnersOf(allCopies(pages));
  const state = computeState([...winners.values()]);
  const synced: Synced[] = [];
  const failures: string[] = [];
  for (const page of pages) {
    if (page.copies.length === 0) continue;
    try {
      synced.push(
        await syncProperties(
          api,
          page,
          page.key ?? pageKeyOf(page),
          eventsOn(idsOn(page), winners),
          state,
        ),
      );
    } catch (error) {
      failures.push(
        `${page.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { synced, failures };
}

function pageKeyOf(page: PageRead): string {
  return changeKeyOf(page.copies, UNFILED_KEY);
}

/** What the store holds that disagrees with the events, one notice each. */
export async function diagnose(
  api: NotionApi,
  database: Database,
): Promise<Array<Record<string, unknown>>> {
  const pages = await readStore(api, database);
  const notices: Array<Record<string, unknown>> = [];
  for (const [id, copies] of idConflicts(allCopies(pages)))
    notices.push({
      kind: "id-conflict",
      id,
      copies: copies.map((copy) => ({ ref: copy.ref, text: copy.text })),
    });
  const winners = winnersOf(allCopies(pages));
  const state = computeState([...winners.values()]);
  for (const page of pages) {
    if (page.hidden === null || page.shown === page.hidden) continue;
    const events = eventsOn(idsOn(page), winners);
    notices.push({
      kind: "status-edited",
      ref: page.url,
      shown: page.shown,
      computed: pageProperties(page.key ?? pageKeyOf(page), events, state)
        .status,
      findings: events
        .filter((event) => event.type === "finding")
        .map((event) => event.id),
    });
  }
  return notices;
}

// ── Creating a store ────────────────────────────────────────────────────────

export interface Created {
  database: string;
  url: string;
  /** Views that could not be set up, with why. */
  viewFailures: string[];
}

/** Create the store's database under a page, with its properties and views. */
export async function createDatabase(
  api: NotionApi,
  parent: string,
): Promise<Created> {
  const database = await api.request("POST", "/v1/databases", {
    parent: { type: "page_id", page_id: parent },
    title: richText("Agent reflections"),
    description: richText(
      `What agent sessions learned about the scaffolding, one page per change, recorded by Jig's reflect skill. The JSON records inside each page are what the skills read. ${STORE_MARK}`,
    ),
    is_inline: false,
    initial_data_source: { properties: propertySchema() },
  });
  const sources = Array.isArray(database.data_sources)
    ? database.data_sources
    : [];
  const source = sources[0];
  if (!isMapping(source) || typeof source.id !== "string")
    throw new NotionError(1, "Notion created a database without a data source");
  const link = linkOf(database);
  const created: Created = {
    database: link.id,
    url: link.url,
    viewFailures: [],
  };
  const viewStep = async (name: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      created.viewFailures.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const described = await api.request("GET", `/v1/data_sources/${source.id}`);
  const ids: Record<string, string> = {};
  if (isMapping(described.properties))
    for (const [name, property] of Object.entries(described.properties))
      if (isMapping(property) && typeof property.id === "string")
        ids[name] = property.id;
  const idOf = (name: string): string => ids[name] ?? name;
  const hidden = HIDDEN_PROPERTIES.map((name) => ({
    property_id: idOf(name),
    visible: false,
  }));
  const newest = [{ property: PROPERTY.last, direction: "descending" }];
  await viewStep("All changes", async () => {
    const views = await api.all(
      "GET",
      `/v1/views?database_id=${encodeURIComponent(link.id)}`,
    );
    for (const view of views)
      if (isMapping(view) && typeof view.id === "string")
        await api.request("PATCH", `/v1/views/${view.id}`, {
          name: "All changes",
          sorts: newest,
          configuration: { type: "table", properties: hidden },
        });
  });
  const base = { database_id: link.id, data_source_id: source.id };
  await viewStep("Inbox", () =>
    api.request("POST", "/v1/views", {
      ...base,
      name: "Inbox",
      type: "table",
      filter: { property: PROPERTY.status, select: { equals: "Inbox" } },
      sorts: newest,
      configuration: { type: "table", properties: hidden },
    }),
  );
  await viewStep("By status", () =>
    api.request("POST", "/v1/views", {
      ...base,
      name: "By status",
      type: "board",
      sorts: newest,
      configuration: {
        type: "board",
        group_by: {
          type: "select",
          property_id: idOf(PROPERTY.status),
          sort: { type: "manual" },
          hide_empty_groups: false,
        },
        properties: hidden,
      },
    }),
  );
  return created;
}

/** The whole events, for `list`, with `since` applied. */
export function listOutput(
  pages: readonly PageRead[],
  since: string | null,
): string[] {
  return distinctById(allCopies(pages))
    .filter((stored) => since === null || stored.event.at >= since)
    .map((stored) => stored.text);
}
