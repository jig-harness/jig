import { decodeJson, isRecord } from "../../../shared/guards.ts";
import { errnoCode, swallow } from "../../../shared/errors.ts";
import { ExitError } from "../../../shared/cli.ts";
import { mkdtemp, readFile, realpath, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

type Scenario = { name: string; url: string; screenshot: string };
type Reply = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
  method?: string;
  params?: Record<string, unknown>;
};

const deadlineMs = 20_000;

async function poll<T>(
  read: () => Promise<T | undefined>,
  description: string,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new ExitError(2, `Timed out waiting for ${description}`);
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
    optional(value.params, isRecord)
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
  let onEvent: (method: string, params: Record<string, unknown>) => void =
    () => {
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
    } else if (reply.method) onEvent(reply.method, reply.params ?? {});
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
    send(method: string, params: Record<string, unknown> = {}) {
      return new Promise<Record<string, unknown>>((resolveReply, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Browser command timed out: ${method}`));
        }, deadlineMs);
        pending.set(id, { resolve: resolveReply, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
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
    if (!inside(root, path)) return new Response("Forbidden", { status: 403 });
    if (pathname.endsWith("/")) path = join(path, "index.html");
    path = await realpath(path);
    if (!inside(root, path)) return new Response("Forbidden", { status: 403 });
    return new Response(Bun.file(path));
  } catch {
    // Chromium requests this icon even when the page does not declare one.
    if (new URL(request.url).pathname === "/favicon.ico")
      return new Response(null, { status: 204 });
    return new Response("Not found", { status: 404 });
  }
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
    "Network.webSocketCreated": (p) => {
      if (new URL(String(p.url)).host !== new URL(state.origin).host)
        fail(state, `external WebSocket ${String(p.url)}`);
    },
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
  client.events((method, params) => handlers[method]?.(params));
}
async function browserEndpoint(
  browser: ReturnType<typeof Bun.spawn>,
  profile: string,
): Promise<string> {
  const port = await poll(async () => {
    if (browser.exitCode !== null)
      throw new ExitError(
        2,
        "Chromium exited before rendering; check the configured executable",
      );
    try {
      return (
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
          "\n",
        )[0] || undefined
      );
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      swallow(error, "Chromium has not written its debugging endpoint yet");
      return undefined;
    }
  }, "Chromium startup");
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(deadlineMs),
  });
  const targets = (await response.json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const target = targets.find((entry) => entry.type === "page");
  if (!target) throw new ExitError(2, "Chromium did not expose a page target");
  return target.webSocketDebuggerUrl;
}
async function configure(client: Client): Promise<void> {
  for (const domain of ["Page", "Runtime", "Network", "Log"])
    await client.send(`${domain}.enable`);
  await client.send("Page.setLifecycleEventsEnabled", { enabled: true });
  await client.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  // Separate execution targets cannot be observed completely by this renderer.
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
    const reject = kind => { console.error("Unsupported rendering target: " + kind); throw new Error("Unsupported rendering target: " + kind); };
    for (const kind of ["Worker", "SharedWorker"]) {
      if (window[kind]) Object.defineProperty(window, kind, {value: function () { reject(kind); }, writable: false, configurable: false});
    }
    if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, "register", {value: function () { reject("service worker"); }, writable: false, configurable: false});
  })();`,
  });
}
async function loadPage(
  client: Client,
  state: RenderState,
  url: string,
  width: number,
): Promise<void> {
  state.active.clear();
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
    return state.loaded.has(String(navigation.loaderId)) && ready && idle
      ? true
      : undefined;
  }, `${state.context} page load`);
  await client.send("Runtime.evaluate", {
    expression:
      "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))",
    awaitPromise: true,
  });
}
async function checkPage(client: Client, state: RenderState): Promise<void> {
  const unsupported = await client.send("Runtime.evaluate", {
    expression: "document.querySelectorAll('iframe,frame,object,embed').length",
    returnByValue: true,
  });
  if (Number((unsupported.result as { value: number }).value) > 0)
    fail(
      state,
      "iframe, frame, object or embed targets are not supported by the renderer",
    );
  const metrics = await client.send("Runtime.evaluate", {
    expression:
      "({width:window.innerWidth,scroll:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth||0)})",
    returnByValue: true,
  });
  const bounds = (
    metrics.result as { value: { width: number; scroll: number } }
  ).value;
  if (bounds.scroll > bounds.width + 1)
    fail(state, `horizontal overflow (${bounds.scroll}px > ${bounds.width}px)`);
}
async function checkRenderedTerms(
  client: Client,
  state: RenderState,
  terms: string[],
): Promise<void> {
  const result = await client.send("Runtime.evaluate", {
    expression: "document.documentElement.innerText",
    returnByValue: true,
  });
  const text = (result.result as { value?: unknown }).value;
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
  const name = scenario.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = resolve(root, `.handback-render/${name}-${width}.png`);
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
      await loadPage(client, state, url.href, width);
      await checkPage(client, state);
      await checkRenderedTerms(client, state, terms);
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
  const profile = await mkdtemp(join(tmpdir(), "jig-design-browser-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => serveFile(bundleRoot, request),
  });
  let browser: ReturnType<typeof Bun.spawn> | undefined;
  let client: Client | undefined;
  try {
    browser = Bun.spawn(
      [
        browserExecutable,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    client = await connect(await browserEndpoint(browser, profile));
    const state: RenderState = {
      context: "bundle",
      origin: `http://127.0.0.1:${server.port}`,
      failures: new Set(),
      active: new Set(),
      loaded: new Set(),
      lastActivity: Date.now(),
    };
    await renderScenarios(client, bundleRoot, scenarios, widths, state, terms);
    return { failures: [...state.failures] };
  } finally {
    client?.close();
    if (browser) await stopBrowser(browser);
    server.stop(true);
    await rm(profile, { recursive: true, force: true });
  }
}
