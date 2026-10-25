import { decodeJson, isRecord } from "../../../shared/guards.ts";
import { errnoCode, swallow } from "../../../shared/errors.ts";
import { ExitError } from "../../../shared/cli.ts";
import { mkdtemp, readFile, realpath, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  generatedPath,
  renderDirectory,
  renderName,
  type Scenario,
} from "./contracts.ts";
type Reply = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

const deadlineMs = 20_000;
// A loaded CI machine can take longer than one command to start the browser.
const startupMs = 60_000;

/** The first defined value `read` returns before the deadline, else undefined. */
async function until<T>(
  read: () => Promise<T | undefined>,
  limitMs = deadlineMs,
): Promise<T | undefined> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  return undefined;
}
async function poll<T>(
  read: () => Promise<T | undefined>,
  description: string,
): Promise<T> {
  const value = await until(read);
  if (value === undefined)
    throw new ExitError(2, `Timed out waiting for ${description}`);
  return value;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function optional(value: unknown, guard: (value: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}
function isReply(value: unknown): value is Reply {
  return (
    isRecord(value) &&
    optional(value.id, (v) => typeof v === "number") &&
    optional(value.method, (v) => typeof v === "string") &&
    optional(
      value.error,
      (v) => isRecord(v) && typeof v.message === "string",
    ) &&
    optional(value.result, isRecord) &&
    optional(value.params, isRecord) &&
    optional(value.sessionId, (v) => typeof v === "string")
  );
}
async function connect(url: string) {
  const socket = new WebSocket(url);
  const pending = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 0;
  let onEvent: (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => void = () => {
    /* Events may arrive before the consumer handler is installed. */
  };
  socket.addEventListener("message", (event) => {
    const reply = decodeJson(
      String(event.data),
      isReply,
      "browser protocol reply",
    );
    if (reply.id !== undefined) {
      const request = pending.get(reply.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(reply.id);
      if (reply.error) request.reject(new Error(reply.error.message));
      else request.resolve(reply.result ?? {});
    } else if (reply.method)
      onEvent(reply.method, reply.params ?? {}, reply.sessionId);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Browser connection closed"));
    }
    pending.clear();
  });
  await new Promise<void>((resolveOpen, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Browser connection timed out"));
    }, deadlineMs);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolveOpen();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Browser connection failed"));
      },
      { once: true },
    );
  });
  return {
    events(handler: typeof onEvent) {
      onEvent = handler;
    },
    send(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) {
      return new Promise<Record<string, unknown>>((resolveReply, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Browser command timed out: ${method}`));
        }, deadlineMs);
        pending.set(id, { resolve: resolveReply, reject, timer });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    close() {
      socket.close();
    },
  };
}

type Client = Awaited<ReturnType<typeof connect>>;
type Params = Record<string, unknown>;
type RenderState = {
  context: string;
  page: string;
  /** Targets rejected so far: a scenario that starts one has already failed. */
  rejected: number;
  origin: string;
  failures: Set<string>;
  active: Set<string>;
  loaded: Set<string>;
  lastActivity: number;
};

async function serveFile(root: string, request: Request): Promise<Response> {
  try {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    let path = resolve(root, `.${pathname}`);
    if (!inside(root, path) || generated(root, path))
      return new Response("Forbidden", { status: 403 });
    if (pathname.endsWith("/")) path = join(path, "index.html");
    path = await realpath(path);
    if (!inside(root, path) || generated(root, path))
      return new Response("Forbidden", { status: 403 });
    return new Response(Bun.file(path));
  } catch {
    // Chromium requests this icon even when the page does not declare one.
    if (new URL(request.url).pathname === "/favicon.ico")
      return new Response(null, { status: 204 });
    return new Response("Not found", { status: 404 });
  }
}
/** The checker's own outputs are never scenario inputs. */
function generated(root: string, path: string): boolean {
  return generatedPath(relative(root, path).split(sep).join("/"));
}
function external(url: string, origin: string): boolean {
  return (
    !url.startsWith("data:") &&
    !url.startsWith("blob:") &&
    new URL(url).origin !== origin
  );
}
function fail(state: RenderState, text: string): void {
  state.failures.add(`${state.context}: ${text}`);
}
function intercept(client: Client, state: RenderState, params: Params): void {
  const { url } = params.request as { url: string };
  const blocked = external(url, state.origin);
  if (blocked) fail(state, `external request ${url}`);
  const args = blocked
    ? { requestId: params.requestId, errorReason: "BlockedByClient" }
    : { requestId: params.requestId };
  void client
    .send(blocked ? "Fetch.failRequest" : "Fetch.continueRequest", args)
    .catch((error: unknown) =>
      fail(state, `request interception failed: ${String(error)}`),
    );
}
function requestStarted(state: RenderState, params: Params): void {
  const { url } = params.request as { url: string };
  state.active.add(String(params.requestId));
  state.lastActivity = Date.now();
  if (external(url, state.origin)) fail(state, `external request ${url}`);
}
function requestEnded(state: RenderState, params: Params): void {
  state.active.delete(String(params.requestId));
  state.lastActivity = Date.now();
}
function attachEvents(client: Client, state: RenderState): void {
  const handlers: Record<string, (params: Params) => void> = {
    "Fetch.requestPaused": (p) => intercept(client, state, p),
    "Page.lifecycleEvent": (p) => {
      if (p.name === "load") state.loaded.add(String(p.loaderId));
    },
    "Network.requestWillBeSent": (p) => requestStarted(state, p),
    "Network.loadingFinished": (p) => requestEnded(state, p),
    "Network.loadingFailed": (p) => {
      requestEnded(state, p);
      if (p.canceled !== true)
        fail(state, `failed resource ${String(p.errorText)}`);
    },
    "Network.responseReceived": (p) => {
      const resource = p.response as { status: number; url: string };
      if (resource.status >= 400)
        fail(state, `HTTP ${resource.status} ${resource.url}`);
    },
    // The browser's proxy refuses the connection itself; this reports it.
    "Network.webSocketCreated": (p) => {
      if (new URL(String(p.url)).host !== new URL(state.origin).host)
        fail(state, `external WebSocket ${String(p.url)}`);
    },
    "Target.attachedToTarget": (p) => rejectTarget(client, state, p),
    "Runtime.exceptionThrown": (p) =>
      fail(state, `runtime exception ${JSON.stringify(p.exceptionDetails)}`),
    "Runtime.consoleAPICalled": (p) => {
      if (p.type === "error")
        fail(state, `console error ${JSON.stringify(p.args)}`);
    },
    "Log.entryAdded": (p) => {
      const entry = p.entry as { level: string; text: string };
      if (entry.level === "error") fail(state, `browser error ${entry.text}`);
    },
  };
  client.events((method, params, sessionId) => {
    // Child sessions are attached only to be held paused, never observed.
    if (sessionId === undefined) handlers[method]?.(params);
  });
}
/**
 * Workers, service workers and other targets run outside the observed page.
 * Each is attached paused at creation and never resumed, and fails the check.
 */
function rejectTarget(
  client: Client,
  state: RenderState,
  params: Params,
): void {
  const target = params.targetInfo as {
    targetId: string;
    type: string;
    url: string;
  };
  if (target.targetId === state.page) return;
  // The browser's own extensions and interface are not bundle content.
  if (
    /^(?:chrome|chrome-extension|chrome-untrusted|devtools):/.test(target.url)
  ) {
    if (params.waitingForDebugger === true)
      void client
        .send("Runtime.runIfWaitingForDebugger", {}, String(params.sessionId))
        .catch((error: unknown) =>
          swallow(error, "a browser-internal target may close before resuming"),
        );
    return;
  }
  state.rejected++;
  fail(state, `unsupported ${target.type} target ${target.url}`);
}
/** Keep the browser's diagnostic output readable without letting it fill the pipe. */
function drain(stream: ReadableStream<Uint8Array>): {
  tail: () => string;
  stop: () => void;
} {
  let tail = "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const read = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-4000);
    }
  };
  read().catch((error: unknown) =>
    swallow(error, "browser diagnostics end with the browser"),
  );
  return {
    tail: () => (tail.trim() ? `\n${tail.trim()}` : ""),
    // The browser's child processes can hold the pipe open after it exits.
    stop: () => {
      reader
        .cancel()
        .catch((error: unknown) =>
          swallow(error, "browser diagnostics already ended"),
        );
    },
  };
}
async function browserEndpoint(
  browser: ReturnType<typeof Bun.spawn>,
  profile: string,
  diagnostics: () => string,
): Promise<{ page: string; browser: string; pageId: string }> {
  const port = await until(async () => {
    if (browser.exitCode !== null)
      throw new ExitError(
        2,
        `Chromium exited before rendering; check the configured executable${diagnostics()}`,
      );
    try {
      return (
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
          "\n",
        )[0] || undefined
      );
    } catch (error) {
      // Windows refuses the read (EBUSY) while Chromium still holds the file
      // open to write it.
      const code = errnoCode(error);
      if (code !== "ENOENT" && code !== "EBUSY") throw error;
      swallow(error, "Chromium has not written its debugging endpoint yet");
      return undefined;
    }
  }, startupMs);
  if (port === undefined)
    throw new ExitError(
      2,
      `Timed out waiting for Chromium startup${diagnostics()}`,
    );
  const read = async (path: string) =>
    (
      await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(deadlineMs),
      })
    ).json();
  const targets = (await read("/json/list")) as {
    id: string;
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const target = targets.find((entry) => entry.type === "page");
  if (!target) throw new ExitError(2, "Chromium did not expose a page target");
  const version = (await read("/json/version")) as {
    webSocketDebuggerUrl: string;
  };
  return {
    page: target.webSocketDebuggerUrl,
    browser: version.webSocketDebuggerUrl,
    pageId: target.id,
  };
}
async function configure(client: Client): Promise<void> {
  for (const domain of ["Page", "Runtime", "Network", "Log"])
    await client.send(`${domain}.enable`);
  await client.send("Page.setLifecycleEventsEnabled", { enabled: true });
  await client.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await holdTargets(client);
}
/** New targets start paused; nothing resumes them. */
async function holdTargets(client: Client): Promise<void> {
  await client.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
}
async function loadPage(
  client: Client,
  state: RenderState,
  url: string,
  width: number,
): Promise<number | null> {
  state.active.clear();
  const rejected = state.rejected;
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // Blank ensures even hash-only scenarios receive a new document loader.
  await client.send("Page.navigate", { url: "about:blank" });
  const navigation = await client.send("Page.navigate", { url });
  if (navigation.errorText || !navigation.loaderId)
    throw new ExitError(
      2,
      `${state.context}: navigation failed: ${String(navigation.errorText ?? "missing document loader")}`,
    );
  await poll(async () => {
    const result = await client.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    const ready = (result.result as { value?: string }).value === "complete";
    const idle = !state.active.size && Date.now() - state.lastActivity >= 250;
    return (state.loaded.has(String(navigation.loaderId)) && ready && idle) ||
      state.rejected > rejected
      ? true
      : undefined;
  }, `${state.context} page load`);
  // A held target can keep the page from settling; the scenario failed already.
  if (state.rejected > rejected) return null;
  await client.send("Runtime.evaluate", {
    expression:
      "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))",
    awaitPromise: true,
  });
  return verifierWorld(client);
}
/**
 * Inspections run in an isolated world: the page shares the DOM with it but
 * cannot replace the globals and prototypes the verifier reads through.
 */
async function verifierWorld(client: Client): Promise<number> {
  const { frameTree } = (await client.send("Page.getFrameTree")) as {
    frameTree: { frame: { id: string } };
  };
  const world = await client.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "jig-handback-verifier",
  });
  return Number(world.executionContextId);
}
async function inspect(
  client: Client,
  world: number,
  expression: string,
): Promise<unknown> {
  const result = await client.send("Runtime.evaluate", {
    expression,
    contextId: world,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new ExitError(
      2,
      `Browser inspection failed: ${JSON.stringify(result.exceptionDetails)}`,
    );
  return (result.result as { value?: unknown }).value;
}
/** The scenario's own declaration that it has rendered, bounded by the deadline. */
async function awaitReady(
  client: Client,
  state: RenderState,
  world: number,
  selector: string,
): Promise<boolean> {
  const expression = `document.querySelector(${JSON.stringify(selector)}) !== null`;
  const ready = await until(async () =>
    (await inspect(client, world, expression)) === true ? true : undefined,
  );
  if (!ready)
    fail(state, `scenario never became ready: no element matches ${selector}`);
  return ready === true;
}
async function checkPage(
  client: Client,
  state: RenderState,
  world: number,
): Promise<void> {
  const unsupported = await inspect(
    client,
    world,
    "document.querySelectorAll('iframe,frame,object,embed').length",
  );
  if (Number(unsupported) > 0)
    fail(
      state,
      "iframe, frame, object or embed targets are not supported by the renderer",
    );
  const bounds = (await inspect(
    client,
    world,
    "({width:window.innerWidth,scroll:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth||0)})",
  )) as { width: number; scroll: number };
  if (bounds.scroll > bounds.width + 1)
    fail(state, `horizontal overflow (${bounds.scroll}px > ${bounds.width}px)`);
}
/** Rendered text, plus what form controls display: their values and placeholders. */
const renderedText = `[document.documentElement.innerText,
  ...[...document.querySelectorAll("input,textarea")].flatMap(e =>
    [e.type === "hidden" ? "" : e.value, e.placeholder || ""])].join("\\n")`;
async function checkRenderedTerms(
  client: Client,
  state: RenderState,
  world: number,
  terms: string[],
): Promise<void> {
  const text = await inspect(client, world, renderedText);
  if (typeof text !== "string")
    throw new ExitError(2, "Browser did not return rendered text");
  for (const term of terms)
    if (text.toLowerCase().includes(term.toLowerCase()))
      fail(state, `forbidden rendered text '${term}'`);
}
async function capture(
  client: Client,
  root: string,
  scenario: Scenario,
  width: number,
): Promise<void> {
  const name = renderName(scenario.name);
  const path = resolve(root, `${renderDirectory}/${name}-${width}.png`);
  await mkdir(dirname(path), { recursive: true });
  if (!inside(root, await realpath(dirname(path))))
    throw new ExitError(2, `Screenshot directory escapes bundle: ${path}`);
  try {
    if (!inside(root, await realpath(path)))
      throw new ExitError(2, `Screenshot escapes bundle: ${path}`);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
    swallow(error, "Screenshot has not been created yet");
  }
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  await Bun.write(path, Buffer.from(String(screenshot.data), "base64"));
}
async function renderScenarios(
  client: Client,
  root: string,
  scenarios: Scenario[],
  widths: number[],
  state: RenderState,
  terms: string[],
): Promise<void> {
  attachEvents(client, state);
  await configure(client);
  for (const scenario of scenarios) {
    const url = new URL(scenario.url, `${state.origin}/`);
    if (url.origin !== state.origin)
      throw new ExitError(
        2,
        `Scenario must use a bundle-relative URL: ${scenario.name}`,
      );
    for (const width of widths) {
      state.context = `${scenario.name} at ${width}px`;
      const world = await loadPage(client, state, url.href, width);
      if (world === null) continue;
      if (!(await awaitReady(client, state, world, scenario.ready))) continue;
      await checkPage(client, state, world);
      await checkRenderedTerms(client, state, world, terms);
      await capture(client, root, scenario, width);
    }
  }
}
async function stopBrowser(
  browser: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  browser.kill();
  await Promise.race([browser.exited, Bun.sleep(1_000)]);
  if (browser.exitCode === null) browser.kill("SIGKILL");
}
/** Render from a local HTTP origin using a consumer-supplied Chromium executable. */
export async function renderBundle(
  root: string,
  scenarios: Scenario[],
  widths: number[],
  browserExecutable: string,
  terms: string[] = [],
): Promise<{ failures: string[] }> {
  if (!browserExecutable.trim())
    throw new ExitError(
      2,
      "A Chromium browser executable is required for rendering",
    );
  if (
    !widths.length ||
    widths.some((width) => !Number.isInteger(width) || width < 1)
  )
    throw new ExitError(2, "Render widths must be positive integers");
  const bundleRoot = await realpath(root);
  // Each resource is acquired inside the cleanup boundary, so a failure
  // part-way releases whatever was already acquired.
  let profile: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let sink: { stop(closeActiveConnections?: boolean): void } | undefined;
  let browser: ReturnType<typeof Bun.spawn> | undefined;
  let client: Client | undefined;
  let session: Client | undefined;
  let diagnostics: ReturnType<typeof drain> | undefined;
  try {
    profile = await mkdtemp(join(tmpdir(), "jig-design-browser-"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => serveFile(bundleRoot, request),
    });
    // Every connection except to the bundle's server goes through this proxy,
    // which closes it unanswered: WebSockets and workers included.
    const proxy = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          socket.end();
        },
        data: () => undefined,
      },
    });
    sink = proxy;
    browser = Bun.spawn(
      [
        browserExecutable,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-sync",
        "--password-store=basic",
        "--use-mock-keychain",
        `--proxy-server=http://127.0.0.1:${proxy.port}`,
        `--proxy-bypass-list=<-loopback>;127.0.0.1:${server.port}`,
        // WebRTC's UDP does not go through the proxy; without this, STUN reaches any host.
        "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    diagnostics = drain(browser.stderr as ReadableStream<Uint8Array>);
    const endpoint = await browserEndpoint(browser, profile, diagnostics.tail);
    client = await connect(endpoint.page);
    session = await connect(endpoint.browser);
    const state: RenderState = {
      context: "bundle",
      page: endpoint.pageId,
      rejected: 0,
      origin: `http://127.0.0.1:${server.port}`,
      failures: new Set(),
      active: new Set(),
      loaded: new Set(),
      lastActivity: Date.now(),
    };
    // Service and shared workers belong to the browser, not the page.
    attachEvents(session, state);
    await holdTargets(session);
    await renderScenarios(client, bundleRoot, scenarios, widths, state, terms);
    return { failures: [...state.failures] };
  } finally {
    client?.close();
    session?.close();
    if (browser) await stopBrowser(browser);
    diagnostics?.stop();
    server?.stop(true);
    sink?.stop(true);
    if (profile) await rm(profile, { recursive: true, force: true });
  }
}
