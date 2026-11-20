import { afterEach } from "bun:test";
import { budgetGovernor, memoryBudgetStore } from "../outbound/budget.ts";
import { apiRouteAt } from "../outbound/gh-route.ts";
import {
  githubCredential,
  setForgeGovernor,
  splitHeaders,
} from "../outbound/github-budget.ts";
import { type GhRun, ghRunFailure } from "../outbound/github.ts";
import { type CallRecord, withLedgerWriter } from "../outbound/ledger.ts";
import { traceGhRunner, unheldForm } from "../trace.ts";
import {
  reasonOf,
  type Serve,
  type TransportUnderTest,
  transportContract,
} from "./outbound-transport-contract.ts";

afterEach(() => setForgeGovernor(null));

type Run = GhRun & { stdout: string };
interface Opts {
  env: Record<string, string>;
  timeoutSec?: number;
}

const ENV = { GH_TOKEN: "contract-gh-token" };

/** The route a `gh api` command line asks, its query kept: the path after the host of a full URL. */
function routeOf(argv: readonly string[]): string {
  const raw = argv[apiRouteAt(argv)] ?? "";
  return raw.replace(/^https?:\/\/[^/]+\//i, "").replace(/^\/+/, "");
}

/** A fake `gh api` over `serve`: it prints the answer's headers only when asked to include them, and fails as gh does on a status that is not a success. */
function fakeGh(serve: Serve) {
  return async (argv: string[]): Promise<Run> => {
    const reply = serve(routeOf(argv));
    if ("network" in reply)
      return {
        code: 1,
        stdout: "",
        stderr:
          "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n",
        timedOut: false,
      };
    const body = reply.status === 304 ? "" : (reply.body ?? "");
    const head = [
      `HTTP/2.0 ${reply.status} ${reasonOf(reply.status)}`,
      ...Object.entries(reply.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    ].join("\r\n");
    const include = argv.includes("--include") || argv.includes("-i");
    const success = reply.status >= 200 && reply.status < 300;
    let message = reasonOf(reply.status);
    try {
      const said: unknown = JSON.parse(body);
      if (typeof said === "object" && said !== null && "message" in said)
        message = String(said.message);
    } catch {
      // A body that is not JSON leaves gh's message at the status's reason.
    }
    return {
      code: success ? 0 : 1,
      stdout: include ? `${head}\r\n\r\n${body}` : body,
      stderr: success
        ? ""
        : reply.status === 304
          ? "gh: HTTP 304\n"
          : `gh: ${message} (HTTP ${reply.status})\n`,
      timedOut: false,
    };
  };
}

transportContract("the gh transport", (serve): TransportUnderTest => {
  const store = memoryBudgetStore();
  setForgeGovernor(budgetGovernor(store, { share: () => null }));
  const records: CallRecord[] = [];
  const held = traceGhRunner<Run, Opts>(
    fakeGh(serve),
    () => 10,
    { env: ENV },
    (failure) => ({
      code: 1,
      stdout: "",
      stderr: failure.reason,
      timedOut: false,
      held: failure,
    }),
  );
  // The unheld form: one case's failure must not hold the forge for the next.
  const run = unheldForm(held) ?? held;
  const ledgered = (args: string[]) =>
    withLedgerWriter(
      (record) => records.push(record),
      () => run(args, { env: ENV }),
    );
  return {
    credential: githubCredential(ENV),
    store,
    records,
    async get(path, kept) {
      const r = await ledgered([
        "api",
        "-i",
        ...(kept === undefined ? [] : ["-H", `If-None-Match: ${kept.etag}`]),
        path,
      ]);
      const failure = ghRunFailure(r);
      const { headers, body } = splitHeaders(r.stdout);
      const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(r.stdout)?.[1] ?? "0");
      const notModified = failure === null && status === 304;
      return {
        failure,
        body:
          failure !== null
            ? null
            : notModified
              ? (kept?.body ?? null)
              : headers === null
                ? r.stdout
                : body,
        notModified,
      };
    },
    async pages(path) {
      const r = await ledgered(["api", "--paginate", path]);
      const failure = ghRunFailure(r);
      return {
        failure,
        items: failure === null ? (JSON.parse(r.stdout) as unknown[]) : [],
      };
    },
  };
});
