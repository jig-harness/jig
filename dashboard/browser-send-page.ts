/**
 * What the Send checks in a real browser share: a page over a fixture whose
 * GitHub API the check answers, with the tokens a browser kept seeded in
 * either storage shape, and readers for what the page posted and kept.
 */
import { expect } from "bun:test";
import type { Browser, BrowserContext, Page, Request } from "playwright-core";
import type {
  LineNeed,
  StateAnswer,
} from "../plugin/dispatch/lib/dashboard-contract.ts";
import { withoutAnswerRecord } from "../plugin/shared/decisions/answer-record.ts";
import { isRecord } from "../plugin/shared/guards.ts";
import { decodeMarker } from "../plugin/shared/records/envelope.ts";
import { settled, shows, type Served } from "./browser-page.ts";
import { LAPTOP } from "./browser-suite.ts";
import type { ScenarioId } from "./fixtures.ts";

export const GITHUB_TOKEN = "github_pat_0123456789abcdefSENDTEST";
/** Where the page keeps its tokens, and where a browser kept its one token before. */
const KEY = "jig-dispatch-dashboard:github-tokens";
export const EARLIER_KEY = "jig-dispatch-dashboard:github-token";

/** CORS answers as GitHub's API gives them, so the browser lets the page read them. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, accept",
  "access-control-allow-methods": "GET, POST",
};

export interface Call {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

export interface Opened {
  page: Page;
  context: BrowserContext;
  /** Every call the page made to GitHub. */
  calls: Call[];
  /** Every request to the dashboard's own server, with its headers and body. */
  local: string[];
  problems: string[];
  /** Opens the same dashboard in another tab of this browser. */
  another: () => Promise<Page>;
}

export type FakeAnswer = { status: number; json: unknown };

/** A token as the page keeps it in the list. */
export interface Seeded {
  token: string;
  login: string;
  owners: string[];
}

export interface SendOptions {
  viewport?: { width: number; height: number };
  touch?: boolean;
  /** The single token of the earlier storage shape, `GITHUB_TOKEN` under this login. */
  kept?: { login: string } | null;
  /** Tokens kept in the list. */
  tokens?: Seeded[];
  /** The login GitHub names for each token; `GITHUB_TOKEN` signs in as maintainer-a. */
  logins?: Record<string, string>;
  github?: (call: Call) => FakeAnswer;
  needs?: LineNeed[];
}

/** What a seeded browser holds, as the page would have written it. */
function seed(o: SendOptions): Array<readonly [string, string]> {
  const seeded: Array<readonly [string, string]> = [];
  if (o.kept != null)
    seeded.push([
      EARLIER_KEY,
      JSON.stringify({ token: GITHUB_TOKEN, login: o.kept.login, at: 1 }),
    ]);
  if (o.tokens !== undefined)
    seeded.push([
      KEY,
      JSON.stringify({ tokens: o.tokens.map((t, i) => ({ ...t, at: i + 1 })) }),
    ]);
  return seeded;
}

/** The Send checks' page opener, over a file's own browser and fixture servers. */
export function sendOpener(suite: {
  requireBrowser: () => Browser;
  served: (scenario: ScenarioId) => Promise<Served>;
}) {
  return async function openSend(
    scenario: ScenarioId,
    o: SendOptions = {},
  ): Promise<Opened> {
    const server = await suite.served(scenario);
    const touch = o.touch === true;
    const context = await suite.requireBrowser().newContext({
      viewport: o.viewport ?? LAPTOP,
      ...(touch ? { hasTouch: true, isMobile: true } : {}),
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const calls: Call[] = [];
    const local: string[] = [];
    const problems: string[] = [];
    const logins = o.logins ?? { [GITHUB_TOKEN]: "maintainer-a" };
    let comment = 0;
    const github =
      o.github ??
      ((call: Call): FakeAnswer => {
        if (call.path === "/user") {
          const login =
            logins[call.authorization?.replace("Bearer ", "") ?? ""];
          return login === undefined
            ? { status: 401, json: { message: "Bad credentials" } }
            : { status: 200, json: { login } };
        }
        comment++;
        return {
          status: 201,
          json: {
            html_url: `https://github.com${call.path.replace("/repos", "").replace("/issues/", "/pull/").replace("/comments", `#issuecomment-${comment}`)}`,
          },
        };
      });
    await context.route("https://api.github.com/**", async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers: CORS });
      const call: Call = {
        method: request.method(),
        path: new URL(request.url()).pathname,
        authorization: (await request.allHeaders()).authorization ?? null,
        body: request.postData() === null ? null : request.postDataJSON(),
      };
      calls.push(call);
      const answer = github(call);
      return route.fulfill({
        status: answer.status,
        headers: CORS,
        json: answer.json,
      });
    });
    const seeded = seed(o);
    // Seeded once per tab, before the page first reads it, and never over what the page keeps.
    if (seeded.length > 0)
      await context.addInitScript(
        ([entries, keys]) => {
          if (sessionStorage.getItem("seeded") !== null) return;
          sessionStorage.setItem("seeded", "1");
          if (keys.some((key) => localStorage.getItem(key) !== null)) return;
          for (const [key, value] of entries) localStorage.setItem(key, value);
        },
        [seeded, [KEY, EARLIER_KEY]] as const,
      );
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        console.error(
          `content security policy: ${event.violatedDirective} ${event.blockedURI}`,
        );
      });
    });
    const open = async (): Promise<Page> => {
      const page = await context.newPage();
      page.on("pageerror", (error) => problems.push(`thrown: ${error}`));
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(message.text());
      });
      page.on("request", (request: Request) => {
        if (!request.url().startsWith(server.origin)) return;
        void request.allHeaders().then((headers) => {
          local.push(
            `${request.url()} ${JSON.stringify(headers)} ${request.postData() ?? ""}`,
          );
        });
      });
      if (o.needs !== undefined)
        await page.route("**/state?*", async (route) => {
          const response = await route.fetch();
          const state = (await response.json()) as { value: StateAnswer };
          if (state.value.line !== null) state.value.line.needs = o.needs ?? [];
          await route.fulfill({ response, json: state });
        });
      await page.goto(`${server.url}&view=needs`);
      await shows(page, ".pNeeds .need");
      await settled(page);
      return page;
    };
    const page = await open();
    return { page, context, calls, local, problems, another: open };
  };
}

/** Opens every card where some wait behind Show all. */
export async function showAll(page: Page): Promise<void> {
  const more = page.getByRole("button", { name: /Show all/ });
  if ((await more.count()) > 0) await more.first().click();
}

export function card(page: Page, target: string) {
  return page.locator(".pNeeds .need", { hasText: target });
}

export function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** The tokens the page keeps in storage, `null` when none are. */
export async function kept(page: Page): Promise<unknown[] | null> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), KEY);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  return isRecord(value) && Array.isArray(value.tokens) ? value.tokens : [];
}

export async function noSideScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

/** The tokens reached GitHub only, each in the header it belongs in. */
export function expectTokenOnlyToGithub(
  opened: Opened,
  tokens: string[] = [GITHUB_TOKEN],
): void {
  for (const request of opened.local)
    for (const token of tokens) expect(request).not.toContain(token);
  for (const call of opened.calls)
    expect(tokens.map((t) => `Bearer ${t}`)).toContain(
      call.authorization ?? "",
    );
}

/** Each comment the page posted: where, with which token, its lines without the record, and the record it carries. */
export function posts(calls: Call[]) {
  return calls
    .filter((c) => c.method === "POST")
    .map((c) => {
      const body = (c.body as { body: string }).body;
      const record = decodeMarker(body, "jig-send-answer", "drive-answer");
      return {
        path: c.path,
        authorization: c.authorization,
        lines: withoutAnswerRecord(body),
        record: record.ok
          ? { ...record.value.envelope, ...record.value.payload }
          : null,
      };
    });
}
