/**
 * A local fake of the Notion API endpoints the Notion store uses, for its
 * tests. It keeps databases, data sources, pages, blocks and views in
 * memory and answers as Notion does where the store depends on it: the
 * pinned version header, bearer tokens, cursor paging, last-edited times to
 * the minute, the size limits on rich text and children, and nested
 * children at most two levels deep in one request.
 */
import { randomUUID } from "node:crypto";
import { NOTION_VERSION } from "../scripts/lib/notion/api.ts";

type Json = Record<string, unknown>;

interface Property {
  id: string;
  name: string;
  type: string;
  config: Json;
}

interface DataSource {
  id: string;
  database: string;
  properties: Map<string, Property>;
}

interface Database {
  id: string;
  url: string;
  title: Json[];
  description: Json[];
  dataSource: string;
}

interface Page {
  id: string;
  url: string;
  dataSource: string;
  created: string;
  edited: string;
  inTrash: boolean;
  properties: Map<string, Json>;
}

export interface Block {
  id: string;
  type: string;
  content: Json;
  parent: string;
  children: string[];
}

export interface Recorded {
  method: string;
  path: string;
}

interface Failure {
  method: string;
  path: RegExp;
  status: number;
  retryAfter?: number;
}

class Refusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | undefined;
  constructor(
    status: number,
    code: string,
    message: string,
    retryAfter?: number,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function answer(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const bad = (message: string) => new Refusal(400, "validation_error", message);
const missing = (what: string) =>
  new Refusal(404, "object_not_found", `Could not find ${what}.`);

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Notion keeps last-edited and created times to the minute. */
function minute(date: Date): string {
  const copy = new Date(date);
  copy.setUTCSeconds(0, 0);
  return copy.toISOString();
}

function richText(value: unknown, where: string): Json[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw bad(`${where} should be an array`);
  if (value.length > 100)
    throw bad(`${where}.length should be ≤ 100, instead was ${value.length}`);
  return value.map((item, index) => {
    if (!isObject(item) || !isObject(item.text))
      throw bad(`${where}[${index}].text should be defined`);
    const content = item.text.content;
    if (typeof content !== "string")
      throw bad(`${where}[${index}].text.content should be a string`);
    if (content.length > 2000)
      throw bad(
        `${where}[${index}].text.content.length should be ≤ 2000, instead was ${content.length}`,
      );
    return {
      type: "text",
      text: { content, link: null },
      annotations: {
        bold: false,
        ...(isObject(item.annotations) ? item.annotations : {}),
      },
      plain_text: content,
      href: null,
    };
  });
}

function optionName(value: unknown, where: string): string {
  if (!isObject(value) || typeof value.name !== "string")
    throw bad(`${where}.name should be a string`);
  if (value.name.includes(","))
    throw bad(`${where}.name cannot contain commas`);
  if (value.name.length > 100) throw bad(`${where}.name is too long`);
  return value.name;
}

/** A property definition from a create-database request. */
function propertyOf(name: string, definition: unknown): Property {
  if (!isObject(definition) || typeof definition.type !== "string")
    throw bad(
      `body.initial_data_source.properties.${name}.type should be defined`,
    );
  const config = definition[definition.type];
  const options = isObject(config) ? config.options : undefined;
  for (const option of Array.isArray(options) ? options : [])
    optionName(option, `${name}.options`);
  return {
    id: name === "Name" ? "title" : randomUUID().slice(0, 4),
    name,
    type: definition.type,
    config: isObject(config) ? config : {},
  };
}

/** A property value as Notion stores it, by type; refuses what Notion would. */
const NORMALIZE: Record<string, (raw: unknown, where: string) => unknown> = {
  title: richText,
  rich_text: richText,
  select: (raw, where) =>
    raw === null ? null : { name: optionName(raw, where) },
  multi_select: (raw, where) => {
    if (!Array.isArray(raw)) throw bad(`${where} should be an array`);
    if (raw.length > 100)
      throw bad(`${where}.length should be ≤ 100, instead was ${raw.length}`);
    return raw.map((option, i) => ({
      name: optionName(option, `${where}[${i}]`),
    }));
  },
  number: (raw, where) => {
    if (raw !== null && typeof raw !== "number")
      throw bad(`${where} should be a number`);
    return raw;
  },
  date: (raw, where) => {
    if (raw !== null && (!isObject(raw) || typeof raw.start !== "string"))
      throw bad(`${where}.start should be a string`);
    return raw;
  },
};

export class FakeNotion {
  readonly token = "secret_fake_token";
  readonly server: ReturnType<typeof Bun.serve>;
  readonly databases = new Map<string, Database>();
  readonly dataSources = new Map<string, DataSource>();
  readonly pages = new Map<string, Page>();
  readonly blocks = new Map<string, Block>();
  /** Children of pages and blocks, in order. */
  readonly children = new Map<string, string[]>();
  readonly views = new Map<string, Json>();
  readonly requests: Recorded[] = [];
  /** The largest page a listing returns, to exercise cursors. */
  pageSize = 100;
  /** The clock behind created and last-edited times. */
  now: () => Date = () => new Date();
  private failures: Failure[] = [];

  constructor() {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => this.handle(request),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** The environment a store command talks to this fake in. */
  env(base: Record<string, string>): Record<string, string> {
    return {
      ...base,
      NOTION_TOKEN: this.token,
      JIG_NOTION_API_URL: this.url,
      JIG_NOTION_INTERVAL_MS: "0",
    };
  }

  stop(): void {
    this.server.stop(true);
  }

  /** Answer the next request matching `method` and `path` with `status`. */
  failNext(
    method: string,
    path: RegExp,
    status: number,
    retryAfter?: number,
  ): void {
    this.failures.push({
      method,
      path,
      status,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });
  }

  /** A page the integration can share: the parent `init` is given. */
  addParentPage(): string {
    const id = randomUUID();
    this.children.set(id, []);
    return id;
  }

  /** A database made by hand, not by `init`. */
  addForeignDatabase(): string {
    const database = this.createDatabase({
      parent: { type: "page_id", page_id: this.addParentPage() },
      title: [{ type: "text", text: { content: "Someone's tasks" } }],
      initial_data_source: {
        properties: { Name: { type: "title", title: {} } },
      },
    });
    return String(database.id);
  }

  countRequests(method: string, path: RegExp): number {
    return this.requests.filter((r) => r.method === method && path.test(r.path))
      .length;
  }

  /** The page holding a change, by its title's start. */
  pagesOf(database: string): Page[] {
    const source = this.databases.get(database)?.dataSource;
    return [...this.pages.values()].filter(
      (page) => page.dataSource === source && !page.inTrash,
    );
  }

  /** A page property's shown text: a select's name, or the text. */
  shown(page: Page, name: string): unknown {
    const value = page.properties.get(name);
    if (value === undefined) return undefined;
    const type = String(value.type);
    const inner = value[type];
    if (type === "select") return isObject(inner) ? inner.name : null;
    if (type === "multi_select")
      return Array.isArray(inner) ? inner.map((o) => (o as Json).name) : [];
    if (type === "rich_text" || type === "title")
      return Array.isArray(inner)
        ? inner.map((t) => (t as Json).plain_text).join("")
        : "";
    if (type === "date") return isObject(inner) ? inner.start : null;
    return inner;
  }

  /** A person setting a select property in Notion. */
  setSelect(page: Page, name: string, option: string | null): void {
    page.properties.set(name, {
      id: this.propertyId(page.dataSource, name),
      type: "select",
      select: option === null ? null : { name: option },
    });
    page.edited = minute(this.now());
  }

  /** A page's blocks in order, top level, each with its children. */
  tree(parent: string): Array<Block & { nested: Block[] }> {
    return (this.children.get(parent) ?? []).map((id) => {
      const block = this.blocks.get(id) as Block;
      return {
        ...block,
        nested: block.children.map((c) => this.blocks.get(c) as Block),
      };
    });
  }

  /** A person editing a block's text. */
  editText(block: Block, text: string): void {
    block.content.rich_text = richText(
      [{ type: "text", text: { content: text } }],
      "rich_text",
    );
    this.touch(block.parent);
  }

  private propertyId(source: string, name: string): string {
    return this.dataSources.get(source)?.properties.get(name)?.id ?? name;
  }

  /** Update the last-edited time of the page a block is in. */
  private touch(parent: string): void {
    let at: string | undefined = parent;
    while (at !== undefined) {
      const page = this.pages.get(at);
      if (page !== undefined) {
        page.edited = minute(this.now());
        return;
      }
      at = this.blocks.get(at)?.parent;
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
    });
    try {
      this.admit(request, url.pathname);
      const body = await this.bodyOf(request);
      return answer(200, this.route(request.method, url, body));
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return answer(
        error.status,
        {
          object: "error",
          status: error.status,
          code: error.code,
          message: error.message,
        },
        error.retryAfter === undefined
          ? {}
          : { "Retry-After": String(error.retryAfter) },
      );
    }
  }

  /** Refuse a request without the token or the pinned version, or one set to fail. */
  private admit(request: Request, path: string): void {
    if (request.headers.get("authorization") !== `Bearer ${this.token}`)
      throw new Refusal(401, "unauthorized", "API token is invalid.");
    if (request.headers.get("notion-version") !== NOTION_VERSION)
      throw new Refusal(
        400,
        "missing_version",
        "Notion-Version header failed validation.",
      );
    const index = this.failures.findIndex(
      (f) => f.method === request.method && f.path.test(path),
    );
    if (index < 0) return;
    const [f] = this.failures.splice(index, 1) as [Failure];
    throw new Refusal(
      f.status,
      f.status === 429
        ? "rate_limited"
        : f.status === 529
          ? "service_overload"
          : "internal_server_error",
      "Injected failure.",
      f.retryAfter,
    );
  }

  private async bodyOf(request: Request): Promise<Json> {
    if (request.method === "GET" || request.method === "DELETE") return {};
    const text = await request.text();
    if (text === "") return {};
    if (Buffer.byteLength(text) > 500_000)
      throw new Refusal(
        413,
        "payload_too_large",
        "Request body exceeds the 500KB limit.",
      );
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) throw bad("Body is not an object.");
    return parsed;
  }

  /** The endpoints, as method, path pattern and handler. */
  private readonly routes: Array<
    [
      string,
      RegExp,
      (match: string[], query: URLSearchParams, body: Json) => Json,
    ]
  > = [
    ["POST", /^\/v1\/databases$/, (_, __, body) => this.createDatabase(body)],
    [
      "GET",
      /^\/v1\/databases\/([^/]+)$/,
      ([id]) => this.databaseObject(this.database(id as string)),
    ],
    [
      "GET",
      /^\/v1\/data_sources\/([^/]+)$/,
      ([id]) => this.dataSourceObject(this.dataSource(id as string)),
    ],
    [
      "POST",
      /^\/v1\/data_sources\/([^/]+)\/query$/,
      ([id], query, body) =>
        this.query(this.dataSource(id as string), query, body),
    ],
    ["POST", /^\/v1\/pages$/, (_, __, body) => this.createPage(body)],
    [
      "GET",
      /^\/v1\/pages\/([^/]+)$/,
      ([id]) => this.pageObject(this.page(id as string)),
    ],
    [
      "PATCH",
      /^\/v1\/pages\/([^/]+)$/,
      ([id], _, body) => this.updatePage(this.page(id as string), body),
    ],
    [
      "GET",
      /^\/v1\/blocks\/([^/]+)\/children$/,
      ([id], query) => this.listChildren(id as string, query),
    ],
    [
      "PATCH",
      /^\/v1\/blocks\/([^/]+)\/children$/,
      ([id], _, body) => this.appendChildren(id as string, body),
    ],
    ["GET", /^\/v1\/views$/, (_, query) => this.listViews(query)],
    ["POST", /^\/v1\/views$/, (_, __, body) => this.createView(body)],
    [
      "PATCH",
      /^\/v1\/views\/([^/]+)$/,
      ([id], _, body) => this.updateView(id as string, body),
    ],
  ];

  private route(method: string, url: URL, body: Json): Json {
    for (const [verb, pattern, handler] of this.routes) {
      const match = verb === method ? pattern.exec(url.pathname) : null;
      if (match !== null)
        return handler(match.slice(1), url.searchParams, body);
    }
    throw new Refusal(
      400,
      "invalid_request_url",
      `Invalid request URL: ${method} ${url.pathname}`,
    );
  }

  private listViews(query: URLSearchParams): Json {
    const database = query.get("database_id") ?? "";
    const views = [...this.views.values()].filter(
      (v) => v.database_id === database,
    );
    return {
      object: "list",
      results: views.map((v) => ({ object: "view", id: v.id })),
      has_more: false,
      next_cursor: null,
    };
  }

  private updateView(id: string, body: Json): Json {
    const view = this.views.get(id);
    if (view === undefined) throw missing(`view ${id}`);
    Object.assign(view, body);
    return view;
  }

  private database(id: string): Database {
    const database = this.databases.get(id);
    if (database === undefined) throw missing(`database with ID: ${id}`);
    return database;
  }

  private dataSource(id: string): DataSource {
    const source = this.dataSources.get(id);
    if (source === undefined) throw missing(`data source with ID: ${id}`);
    return source;
  }

  private page(id: string): Page {
    const page = this.pages.get(id);
    if (page === undefined) throw missing(`page with ID: ${id}`);
    return page;
  }

  private createDatabase(body: Json): Json {
    const parent = body.parent;
    if (
      !isObject(parent) ||
      parent.type !== "page_id" ||
      typeof parent.page_id !== "string"
    )
      throw bad("body.parent should be a page_id parent");
    if (!this.children.has(parent.page_id))
      throw missing(`page with ID: ${parent.page_id}`);
    const initial = isObject(body.initial_data_source)
      ? body.initial_data_source
      : {};
    const definitions = isObject(initial.properties) ? initial.properties : {};
    const id = randomUUID();
    const source: DataSource = {
      id: randomUUID(),
      database: id,
      properties: new Map(),
    };
    for (const [name, definition] of Object.entries(definitions))
      source.properties.set(name, propertyOf(name, definition));
    const database: Database = {
      id,
      url: `https://www.notion.so/${id.replaceAll("-", "")}`,
      title: richText(body.title, "body.title"),
      description: richText(body.description, "body.description"),
      dataSource: source.id,
    };
    this.databases.set(id, database);
    this.dataSources.set(source.id, source);
    const view = randomUUID();
    this.views.set(view, {
      object: "view",
      id: view,
      database_id: id,
      data_source_id: source.id,
      name: "Default view",
      type: "table",
    });
    return this.databaseObject(database);
  }

  private databaseObject(database: Database): Json {
    return {
      object: "database",
      id: database.id,
      url: database.url,
      title: database.title,
      description: database.description,
      in_trash: false,
      data_sources: [{ id: database.dataSource, name: "Data source" }],
    };
  }

  private dataSourceObject(source: DataSource): Json {
    const properties: Json = {};
    for (const property of source.properties.values())
      properties[property.name] = {
        id: property.id,
        name: property.name,
        type: property.type,
        [property.type]: property.config,
      };
    return { object: "data_source", id: source.id, properties };
  }

  private propertyValue(
    source: DataSource,
    name: string,
    value: unknown,
  ): Json {
    const property = source.properties.get(name);
    if (property === undefined)
      throw bad(`${name} is not a property that exists.`);
    if (!isObject(value))
      throw bad(`body.properties.${name} should be an object`);
    const raw = value[property.type];
    const where = `body.properties.${name}.${property.type}`;
    if (raw === undefined) throw bad(`${where} should be defined`);
    const normalize = NORMALIZE[property.type] ?? ((v: unknown) => v);
    return {
      id: property.id,
      type: property.type,
      [property.type]: normalize(raw, where),
    };
  }

  private createPage(body: Json): Json {
    const parent = body.parent;
    if (
      !isObject(parent) ||
      parent.type !== "data_source_id" ||
      typeof parent.data_source_id !== "string"
    )
      throw bad("body.parent should be a data_source_id parent");
    const source = this.dataSource(parent.data_source_id);
    const id = randomUUID();
    const at = minute(this.now());
    const page: Page = {
      id,
      url: `https://www.notion.so/${id.replaceAll("-", "")}`,
      dataSource: source.id,
      created: at,
      edited: at,
      inTrash: false,
      properties: new Map(),
    };
    for (const name of source.properties.keys())
      page.properties.set(name, this.emptyValue(source, name));
    for (const [name, value] of Object.entries(
      isObject(body.properties) ? body.properties : {},
    ))
      page.properties.set(name, this.propertyValue(source, name, value));
    this.pages.set(id, page);
    this.children.set(id, []);
    if (body.children !== undefined)
      this.insert(id, body.children, { type: "end" });
    return this.pageObject(page);
  }

  private emptyValue(source: DataSource, name: string): Json {
    const property = source.properties.get(name) as Property;
    const empty: Record<string, unknown> = {
      title: [],
      rich_text: [],
      select: null,
      multi_select: [],
      number: null,
      date: null,
    };
    return {
      id: property.id,
      type: property.type,
      [property.type]: empty[property.type] ?? null,
    };
  }

  /** A page as Notion returns it, with only `names` among its properties when given. */
  private pageObject(page: Page, names?: string[]): Json {
    const properties: Json = {};
    for (const [name, value] of page.properties)
      if (
        names === undefined ||
        names.includes(name) ||
        names.includes(String(value.id))
      )
        properties[name] = value;
    return {
      object: "page",
      id: page.id,
      url: page.url,
      created_time: page.created,
      last_edited_time: page.edited,
      in_trash: page.inTrash,
      parent: { type: "data_source_id", data_source_id: page.dataSource },
      properties,
    };
  }

  private updatePage(page: Page, body: Json): Json {
    const source = this.dataSource(page.dataSource);
    for (const [name, value] of Object.entries(
      isObject(body.properties) ? body.properties : {},
    ))
      page.properties.set(name, this.propertyValue(source, name, value));
    if (typeof body.in_trash === "boolean") page.inTrash = body.in_trash;
    page.edited = minute(this.now());
    return this.pageObject(page);
  }

  private paged<T>(
    items: T[],
    cursor: string | null,
    size: unknown,
  ): { results: T[]; has_more: boolean; next_cursor: string | null } {
    const wanted = typeof size === "number" ? size : 100;
    if (wanted > 100) throw bad("page_size should be ≤ 100");
    const take = Math.min(wanted, this.pageSize);
    const start = cursor === null ? 0 : Number(cursor);
    const results = items.slice(start, start + take);
    const more = start + take < items.length;
    return {
      results,
      has_more: more,
      next_cursor: more ? String(start + take) : null,
    };
  }

  private query(source: DataSource, query: URLSearchParams, body: Json): Json {
    const names = query.getAll("filter_properties");
    const pages = [...this.pages.values()]
      .filter((p) => p.dataSource === source.id && !p.inTrash)
      .reverse();
    const cursor =
      typeof body.start_cursor === "string" ? body.start_cursor : null;
    const page = this.paged(pages, cursor, body.page_size);
    return {
      object: "list",
      type: "page_or_data_source",
      page_or_data_source: {},
      ...page,
      results: page.results.map((p) =>
        this.pageObject(p, names.length === 0 ? undefined : names),
      ),
    };
  }

  private blockObject(block: Block): Json {
    const { children: _, ...content } = block.content;
    return {
      object: "block",
      id: block.id,
      type: block.type,
      has_children: block.children.length > 0,
      in_trash: false,
      [block.type]: content,
    };
  }

  private listChildren(parent: string, query: URLSearchParams): Json {
    const ids = this.children.get(parent);
    if (ids === undefined) throw missing(`block with ID: ${parent}`);
    const size = query.get("page_size");
    const page = this.paged(
      ids,
      query.get("start_cursor"),
      size === null ? undefined : Number(size),
    );
    return {
      object: "list",
      type: "block",
      block: {},
      ...page,
      results: page.results.map((id) =>
        this.blockObject(this.blocks.get(id) as Block),
      ),
    };
  }

  private appendChildren(parent: string, body: Json): Json {
    if (!this.children.has(parent)) throw missing(`block with ID: ${parent}`);
    for (const key of Object.keys(body))
      if (key !== "children" && key !== "position")
        throw bad(`body.${key} is not allowed`);
    const position = body.position ?? { type: "end" };
    const created = this.insert(parent, body.children, position);
    this.touch(parent);
    return {
      object: "list",
      type: "block",
      block: {},
      results: created.map((b) => this.blockObject(b)),
      has_more: false,
      next_cursor: null,
    };
  }

  /** Make blocks from a request's children and insert them under `parent`. */
  private insert(
    parent: string,
    children: unknown,
    position: unknown,
    depth = 1,
  ): Block[] {
    if (!Array.isArray(children)) throw bad("body.children should be an array");
    if (children.length > 100)
      throw bad(
        `body.children.length should be ≤ 100, instead was ${children.length}`,
      );
    if (depth > 2)
      throw bad("children may nest at most two levels in one request");
    const made: Block[] = children.map((child, index) => {
      if (
        !isObject(child) ||
        typeof child.type !== "string" ||
        !isObject(child[child.type])
      )
        throw bad(`body.children[${index}] should be a block`);
      const content: Json = { ...(child[child.type] as Json) };
      for (const field of ["rich_text", "caption"])
        if (content[field] !== undefined)
          content[field] = richText(
            content[field],
            `body.children[${index}].${child.type}.${field}`,
          );
      const block: Block = {
        id: randomUUID(),
        type: child.type,
        content,
        parent,
        children: [],
      };
      this.blocks.set(block.id, block);
      this.children.set(block.id, block.children);
      if (content.children !== undefined) {
        this.insert(block.id, content.children, { type: "end" }, depth + 1);
        delete content.children;
      }
      return block;
    });
    const list = this.children.get(parent) as string[];
    let at = list.length;
    if (isObject(position) && position.type === "start") at = 0;
    else if (isObject(position) && position.type === "after_block") {
      const after = isObject(position.after_block)
        ? position.after_block.id
        : undefined;
      const index = list.indexOf(String(after));
      if (index < 0)
        throw bad(
          `body.position.after_block.id ${String(after)} is not a child of ${parent}`,
        );
      at = index + 1;
    } else if (!isObject(position) || position.type !== "end")
      throw bad("body.position.type is invalid");
    list.splice(at, 0, ...made.map((b) => b.id));
    return made;
  }

  private createView(body: Json): Json {
    const database =
      typeof body.database_id === "string"
        ? this.database(body.database_id)
        : null;
    if (database === null) throw bad("body.database_id should be defined");
    if (body.data_source_id !== database.dataSource)
      throw bad("body.data_source_id does not belong to the database");
    if (typeof body.name !== "string" || typeof body.type !== "string")
      throw bad("body.name and body.type should be defined");
    const configuration = body.configuration;
    if (isObject(configuration) && configuration.type !== body.type)
      throw bad("body.configuration.type should match body.type");
    const id = randomUUID();
    const view = { object: "view", id, ...body };
    this.views.set(id, view);
    return view;
  }
}
