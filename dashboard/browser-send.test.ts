/**
 * Send in a real browser against the real server, with GitHub's API answered
 * by the test: with no token kept no card has Send; the settings panel tests a
 * pasted token with GitHub, names its login and forgets it; Send waits for an
 * option to be picked, then posts each decision's lines Copy takes as its own
 * comment carrying the `drive-answer` record, and the card says it was sent
 * here; a guarded pick sends only on the second step; GitHub's refusals
 * are explained; a card no drive reads an answer comment for says why it has
 * no Send; and at phone widths, by touch alone, it all works with no
 * horizontal scroll and 44 px targets. The token never reaches the
 * dashboard's server. How the browser is found and when its absence fails is
 * `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import type { BrowserContext, Page, Request } from "playwright-core";
import { withoutAnswerRecord } from "../plugin/shared/decisions/answer-record.ts";
import { decodeMarker } from "../plugin/shared/records/envelope.ts";
import { PICK_DIGESTS } from "./fixture-picks.ts";
import { settled, shortControls, shows, until } from "./browser-page.ts";
import { browserSuite, LAPTOP, PHONE, TIMEOUT } from "./browser-suite.ts";
import type { ScenarioId } from "./fixtures.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

const GITHUB_TOKEN = "github_pat_0123456789abcdefSENDTEST";
const KEY = "jig-dispatch-dashboard:github-token";
const NARROW = { width: 320, height: 568 };
const BEFORE = "the clipboard before";

/** CORS answers as GitHub's API gives them, so the browser lets the page read them. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, accept",
  "access-control-allow-methods": "GET, POST",
};

interface Call {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

interface Opened {
  page: Page;
  context: BrowserContext;
  /** Every call the page made to GitHub. */
  calls: Call[];
  /** Every request to the dashboard's own server, with its headers and body. */
  local: string[];
  problems: string[];
}

type Answer = { status: number; json: unknown };

async function openSend(
  scenario: ScenarioId,
  o: {
    viewport?: { width: number; height: number };
    touch?: boolean;
    kept?: { login: string } | null;
    github?: (call: Call) => Answer;
  } = {},
): Promise<Opened> {
  const server = await served(scenario);
  const touch = o.touch === true;
  const context = await requireBrowser().newContext({
    viewport: o.viewport ?? LAPTOP,
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const calls: Call[] = [];
  const local: string[] = [];
  const problems: string[] = [];
  let comment = 0;
  const github =
    o.github ??
    ((call: Call): Answer => {
      if (call.path === "/user")
        return { status: 200, json: { login: "maintainer-a" } };
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
  if (o.kept != null)
    await context.addInitScript(
      ([key, value]) => {
        if (localStorage.getItem(key) === null)
          localStorage.setItem(key, value);
      },
      [
        KEY,
        JSON.stringify({ token: GITHUB_TOKEN, login: o.kept.login, at: 1 }),
      ] as const,
    );
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(
        `content security policy: ${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
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
  await page.goto(`${server.url}&view=needs`);
  await shows(page, ".pNeeds .need");
  await settled(page);
  return { page, context, calls, local, problems };
}

/** Opens every card where some wait behind Show all. */
async function showAll(page: Page): Promise<void> {
  const more = page.getByRole("button", { name: /Show all/ });
  if ((await more.count()) > 0) await more.first().click();
}

function card(page: Page, target: string) {
  return page.locator(".pNeeds .need", { hasText: target });
}

function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

function kept(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), KEY);
}

async function noSideScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

/** The token reached GitHub only, in the header it belongs in. */
function expectTokenOnlyToGithub(opened: Opened): void {
  for (const request of opened.local)
    expect(request).not.toContain(GITHUB_TOKEN);
  for (const call of opened.calls)
    expect(call.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
}

const TWO = [
  `answer PRRT_flag: choose Remove [${PICK_DIGESTS.flag}]`,
  "",
  `answer PRRT_table: approve [${PICK_DIGESTS.table}]`,
].join("\n");

/** Each comment the page posted: where, its lines without the record, and the record it carries. */
function posts(calls: Call[]) {
  return calls
    .filter((c) => c.method === "POST")
    .map((c) => {
      const body = (c.body as { body: string }).body;
      const record = decodeMarker(body, "jig-send-answer", "drive-answer");
      return {
        path: c.path,
        lines: withoutAnswerRecord(body),
        record: record.ok
          ? { ...record.value.envelope, ...record.value.payload }
          : null,
      };
    });
}

describe("Send", () => {
  browserIt(
    "with no token kept no card has Send, nothing calls GitHub, and the head offers it",
    async () => {
      const opened = await openSend("picks");
      try {
        const { page } = opened;
        expect(await page.locator(".copy.send").count()).toBe(0);
        expect(await page.locator(".noSend").count()).toBe(0);
        await page.getByRole("button", { name: "Send from here" }).click();
        await shows(page, ".sendSettings");
        expect(await page.locator(".sendSettings").textContent()).toContain(
          "example-org/api, example-org/web",
        );
        expect(opened.calls).toEqual([]);
        expect(opened.problems).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "the settings panel tests a pasted token with GitHub, names its login, keeps it here alone and forgets it",
    async () => {
      const opened = await openSend("picks", {
        github: (call) =>
          call.authorization === "Bearer wrong"
            ? { status: 401, json: { message: "Bad credentials" } }
            : { status: 200, json: { login: "maintainer-a" } },
      });
      const { page } = opened;
      try {
        await page.getByRole("button", { name: "Send from here" }).click();
        const field = page.getByLabel("GitHub token");
        await field.fill("wrong");
        await page.getByRole("button", { name: "Test and keep" }).click();
        await until("the refusal shows", async () =>
          ((await page.locator(".sendSettings").textContent()) ?? "").includes(
            "401: Bad credentials",
          ),
        );
        expect(await kept(page)).toBeNull();
        expect(await page.locator(".copy.send").count()).toBe(0);

        await field.fill(GITHUB_TOKEN);
        await field.press("Enter");
        await until("the login shows", async () =>
          ((await page.locator(".sendSettings").textContent()) ?? "").includes(
            "it posts as maintainer-a",
          ),
        );
        expect(JSON.parse((await kept(page)) ?? "{}")).toMatchObject({
          token: GITHUB_TOKEN,
          login: "maintainer-a",
        });
        expect(opened.calls.at(-1)).toMatchObject({
          method: "GET",
          path: "/user",
        });
        // Every github.com card now has Send beside Copy.
        expect(await page.locator(".copy.send").count()).toBe(3);
        expect(
          await page
            .getByRole("button", { name: "Sending as maintainer-a" })
            .count(),
        ).toBe(1);

        // A reload keeps it; the host never saw it.
        await page.reload();
        await shows(page, ".pNeeds .need");
        await settled(page);
        expect(await page.locator(".copy.send").count()).toBe(3);
        expect(opened.local.length).toBeGreaterThan(0);
        for (const request of opened.local)
          expect(request).not.toContain(GITHUB_TOKEN);

        await page
          .getByRole("button", { name: "Sending as maintainer-a" })
          .click();
        await page.getByRole("button", { name: "Forget the token" }).click();
        await until("Send is gone", async () =>
          page
            .locator(".copy.send")
            .count()
            .then((n) => n === 0),
        );
        expect(await kept(page)).toBeNull();
        // The browser reports the refused test's 401 itself; nothing else went wrong.
        expect(
          opened.problems.filter((p) => !p.includes("status of 401")),
        ).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "Send posts exactly what Copy copies to the card's pull request, as the person, and the card says it was sent here",
    async () => {
      const opened = await openSend("picks", {
        kept: { login: "maintainer-a" },
      });
      const { page } = opened;
      try {
        const two = card(page, "PR #502");
        // Nothing picked yet: Send waits, posts nothing and says why.
        const send = two.getByRole("button", {
          name: "Send the answers for PR #502 as maintainer-a",
        });
        expect(await send.getAttribute("aria-disabled")).toBe("true");
        // A held-back button still says why when pressed.
        await send.click({ force: true });
        await until("Send said why", async () =>
          ((await page.locator(".say").textContent()) ?? "").includes(
            "Not sent: Send needs an option picked on PR #502",
          ),
        );
        expect(opened.calls).toEqual([]);

        await two
          .getByRole("button", { name: "1 other option" })
          .first()
          .click();
        await two.locator(".opt", { hasText: "Remove" }).click();
        await two.locator(".opt", { hasText: "Later" }).click();
        await page.evaluate((t) => navigator.clipboard.writeText(t), BEFORE);
        await two
          .getByRole("button", { name: "Copy the answers for PR #502" })
          .click();
        await until(
          "Copy copied",
          async () => (await clipboard(page)) !== BEFORE,
        );
        expect(await clipboard(page)).toBe(TWO);

        await two
          .getByRole("button", {
            name: "Send the answers for PR #502 as maintainer-a",
          })
          .click();
        await until("the card says it was sent", async () =>
          two
            .locator(".sentHere")
            .count()
            .then((n) => n === 1),
        );
        // One comment per decision: Copy's lines for it, then the record jig send writes.
        const sent = posts(opened.calls);
        expect(sent.map((p) => p.path)).toEqual([
          "/repos/example-org/web/issues/502/comments",
          "/repos/example-org/web/issues/502/comments",
        ]);
        expect(sent.map((p) => p.lines).join("\n\n")).toBe(TWO);
        expect(sent.map((p) => p.record)).toEqual([
          expect.objectContaining({
            kind: "drive-answer",
            key: "answer:PRRT_flag",
            writer: { login: "maintainer-a", host: "dashboard (browser)" },
            pr: 502,
            decision: PICK_DIGESTS.flag,
            choice: { option: "Remove", form: "choose" },
          }),
          expect.objectContaining({
            key: "answer:PRRT_table",
            decision: PICK_DIGESTS.table,
            choice: { option: "Later", form: "approve" },
          }),
        ]);
        expect(
          await two
            .locator(".sentHere")
            .getByRole("link")
            .evaluateAll((links) => links.map((a) => a.getAttribute("href"))),
        ).toEqual([
          "https://github.com/example-org/web/pull/502#issuecomment-1",
          "https://github.com/example-org/web/pull/502#issuecomment-2",
        ]);
        expect(await two.locator(".sentHere").textContent()).toContain(
          "Sent here",
        );
        expectTokenOnlyToGithub(opened);
        expect(opened.problems).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "with nothing picked Send posts no approval while Copy still copies it, and a pick enables Send",
    async () => {
      const opened = await openSend("picks", {
        kept: { login: "maintainer-a" },
      });
      const { page } = opened;
      const one = card(page, "PR #501");
      const send = one.getByRole("button", {
        name: "Send the answers for PR #501 as maintainer-a",
      });
      try {
        expect(await send.getAttribute("aria-disabled")).toBe("true");
        expect(await one.locator(".sendWaits").textContent()).toContain(
          "Send posts once you pick an option",
        );
        // Copy keeps its approval of the recommendation with nothing picked.
        await page.evaluate((t) => navigator.clipboard.writeText(t), BEFORE);
        await one
          .getByRole("button", { name: "Copy the approval for PR #501" })
          .click();
        await until(
          "Copy copied",
          async () => (await clipboard(page)) !== BEFORE,
        );
        expect(await clipboard(page)).toBe(
          `answer PRRT_one: approve [${PICK_DIGESTS.one}]`,
        );
        await send.click({ force: true });
        await until("Send said why", async () =>
          ((await page.locator(".say").textContent()) ?? "").includes(
            "Send needs an option picked on PR #501",
          ),
        );
        expect(opened.calls).toEqual([]);

        await one.locator(".opt", { hasText: "Keep it" }).click();
        await until(
          "the pick enabled Send",
          async () => (await send.getAttribute("aria-disabled")) === "false",
        );
        expect(await one.locator(".sendWaits").count()).toBe(0);
        await send.click();
        await until("the pick was sent", async () => opened.calls.length === 1);
        expect(posts(opened.calls)[0]).toMatchObject({
          lines: `answer PRRT_one: approve [${PICK_DIGESTS.one}]`,
          record: {
            key: "answer:PRRT_one",
            choice: { option: "Keep it", form: "approve" },
          },
        });
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a guarded pick sends only on the second step, which a changed pick ends",
    async () => {
      const opened = await openSend("picks", {
        kept: { login: "maintainer-a" },
      });
      const { page } = opened;
      const guarded = card(page, "PR #1300");
      const send = guarded.getByRole("button", {
        name: "Send the answers for PR #1300 as maintainer-a",
      });
      try {
        await showAll(page);
        await guarded.getByRole("button", { name: "1 other option" }).click();
        await guarded.locator(".opt", { hasText: "Drop" }).last().click();
        await send.click();
        await shows(page, ".pNeeds .guard");
        expect(await guarded.locator(".guard").textContent()).toContain(
          "before you send",
        );
        expect(await guarded.locator(".guard").textContent()).toContain(
          "no rollback once deployed",
        );
        expect(opened.calls).toEqual([]);
        // A changed pick ends the step.
        await guarded.locator(".opt", { hasText: "Do not drop" }).click();
        await until(
          "the step ended",
          async () => (await guarded.locator(".guard").count()) === 0,
        );
        await guarded.locator(".opt", { hasText: "Drop" }).last().click();
        await send.click();
        await shows(page, ".pNeeds .guard");
        await guarded
          .getByRole("button", {
            name: "Confirm and send the answers for PR #1300 as maintainer-a",
          })
          .click();
        await until(
          "the second step sent",
          async () => opened.calls.length === 1,
        );
        expect(opened.calls[0]).toMatchObject({
          method: "POST",
          path: "/repos/example-org/api/issues/1300/comments",
        });
        expect(posts(opened.calls)[0]).toMatchObject({
          lines: `answer PRRT_drop: choose Drop [${PICK_DIGESTS.drop}]`,
          record: {
            key: "answer:PRRT_drop",
            choice: { option: "Drop", form: "choose" },
          },
        });
        await until(
          "the panel closed",
          async () => (await guarded.locator(".guard").count()) === 0,
        );
        expect(opened.problems).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "GitHub's refusals are explained, and a login other than the park's person is named",
    async () => {
      const answers: Answer[] = [
        { status: 404, json: { message: "Not Found" } },
        {
          status: 403,
          json: { message: "Resource not accessible by personal access token" },
        },
        { status: 422, json: { message: "Validation Failed" } },
      ];
      const opened = await openSend("picks", {
        kept: { login: "someone-else" },
        github: () => answers.shift() ?? { status: 500, json: {} },
      });
      const { page } = opened;
      const one = card(page, "PR #501");
      const send = one.getByRole("button", {
        name: "Send the answers for PR #501 as someone-else",
      });
      try {
        expect(await one.locator(".sendSaid").textContent()).toContain(
          "Sends as someone-else; this waits on maintainer-a",
        );
        await one.locator(".opt", { hasText: "Keep it" }).click();
        for (const said of [
          "404: Not Found",
          "403: Resource not accessible by personal access token",
          "422: Validation Failed",
        ]) {
          await send.click();
          await until(`the card says ${said}`, async () =>
            ((await one.locator(".sendSaid").textContent()) ?? "").includes(
              said,
            ),
          );
          expect(await one.locator(".sendSaid").textContent()).toContain(
            "nothing was posted",
          );
        }
        expect(await one.locator(".sentHere").count()).toBe(0);
        expect(opened.calls).toHaveLength(3);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a card no drive reads an answer comment for, or not on github.com, says why it has no Send",
    async () => {
      const opened = await openSend("loud", {
        kept: { login: "maintainer-a" },
      });
      const { page } = opened;
      try {
        await showAll(page);
        expect(await page.locator(".copy.send").count()).toBe(0);
        const why = await page.locator(".noSend").allTextContents();
        expect(
          why.some((t) => t.includes("only a drive's parked decisions")),
        ).toBe(true);
        expect(
          why.some((t) =>
            t.includes(
              "Send posts to github.com only, and this pull request is at forge.example",
            ),
          ),
        ).toBe(true);
        expect(opened.calls).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  for (const viewport of [PHONE, NARROW])
    browserIt(
      `at ${viewport.width} px, by touch alone, a token is kept and a card sends, with no side scroll and 44 px targets`,
      async () => {
        const opened = await openSend("picks", { viewport, touch: true });
        const { page } = opened;
        try {
          await page.getByRole("button", { name: "Send from here" }).tap();
          await shows(page, ".sendSettings");
          await page.getByLabel("GitHub token").tap();
          await page.keyboard.type(GITHUB_TOKEN);
          await page.getByRole("button", { name: "Test and keep" }).tap();
          await until("the login shows", async () =>
            (
              (await page.locator(".sendSettings").textContent()) ?? ""
            ).includes("it posts as maintainer-a"),
          );
          await noSideScroll(page);
          expect(await shortControls(page)).toEqual([]);
          await page.getByRole("button", { name: "Close" }).tap();

          const two = card(page, "PR #502");
          await two
            .getByRole("button", { name: "1 other option" })
            .first()
            .tap();
          await two.locator(".opt", { hasText: "Remove" }).tap();
          await two.locator(".opt", { hasText: "Later" }).tap();
          await two
            .getByRole("button", {
              name: "Send the answers for PR #502 as maintainer-a",
            })
            .tap();
          await until("the card says it was sent", async () =>
            two
              .locator(".sentHere")
              .count()
              .then((n) => n === 1),
          );
          expect(opened.calls.at(-1)).toMatchObject({
            method: "POST",
            path: "/repos/example-org/web/issues/502/comments",
          });
          expect(
            posts(opened.calls)
              .map((p) => p.lines)
              .join("\n\n"),
          ).toBe(TWO);
          await noSideScroll(page);
          expect(await shortControls(page)).toEqual([]);
          expectTokenOnlyToGithub(opened);
          expect(opened.problems).toEqual([]);
        } finally {
          await opened.context.close();
        }
      },
      TIMEOUT,
    );
});
