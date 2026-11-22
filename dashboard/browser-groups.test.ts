import { ok as assert } from "node:assert/strict";
/**
 * A question group on Needs you, in a real browser against the real server,
 * with GitHub's API answered by the test: three stalled pickups whose
 * decisions differ only in their item are one card listing each; one pick
 * and one confirmed Send post one answer on each target listed, as the
 * person, and none on a target left out; the next read shows each target's
 * outcome, and the target whose answer the tick refused is a card of its
 * own. How the browser is found and when its absence fails is
 * `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import type { Page } from "playwright-core";
import { withoutAnswerRecord } from "../plugin/shared/decisions/answer-record.ts";
import { decodeMarker } from "../plugin/shared/records/envelope.ts";
import { BROWSER_HOST } from "../plugin/shared/records/writer-shape.ts";
import type {
  LineNeed,
  StateAnswer,
} from "../plugin/dispatch/lib/dashboard-contract.ts";
import { decisionOf } from "../plugin/dispatch/lib/line-decision.ts";
import { frameStationDecision } from "../plugin/shared/decisions/station.ts";
import { dispatcherDecisionDigest } from "../plugin/shared/decisions/station-digest.ts";
import { fixture } from "./fixtures.ts";
import { settled, shortControls, shows, until } from "./browser-page.ts";
import { browserSuite, PHONE, TIMEOUT } from "./browser-suite.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

const KEY = "jig-dispatch-dashboard:github-token";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, accept",
  "access-control-allow-methods": "GET, POST",
};

/** Three stalled pickups of one repository, each framed by the dispatcher and answered on its issue. */
function stalledPickups(): LineNeed[] {
  const base = fixture("picks").line?.needs[0];
  assert(base);
  return [17, 27, 37].map((n, i) => {
    const item = `#${n}`;
    const framed = frameStationDecision({
      kind: "stalled",
      item,
      state: "In Progress",
      carriedBy: [],
    });
    return {
      ...base,
      cause: "stalled",
      stage: "pickup",
      target: item,
      pr: null,
      item,
      title: `Item ${n}`,
      since: new Date(Date.parse(base.since) + i * 60_000).toISOString(),
      reason: `the pickup of ${item} stalled`,
      url: `https://github.com/${base.repo}/issues/${n}`,
      decisions: [
        {
          ...decisionOf({
            key: framed.key,
            kind: "finding",
            decision: framed.decision,
            digest: dispatcherDecisionDigest(framed),
            lines: [],
          }),
          answer: {
            station: "pickup",
            address: `pickup@${base.repo}#${n}`,
            on: "issue",
            framedBy: "dispatcher",
          },
        },
      ],
    } as LineNeed;
  });
}

interface Posted {
  path: string;
  body: string;
}

/** Opens Needs you over `needs`, which the test may change between reads, with a token kept and GitHub answered here. */
async function open(
  needs: { current: LineNeed[] },
  viewport?: { width: number; height: number },
) {
  const server = await served("picks");
  const context = await requireBrowser().newContext(
    viewport === undefined ? {} : { viewport, hasTouch: true, isMobile: true },
  );
  const posted: Posted[] = [];
  const problems: string[] = [];
  await context.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: CORS });
    const path = new URL(request.url()).pathname;
    posted.push({
      path,
      body: (request.postDataJSON() as { body: string }).body,
    });
    return route.fulfill({
      status: 201,
      headers: CORS,
      json: {
        html_url: `https://github.com${path.replace("/repos", "").replace("/comments", `#issuecomment-${posted.length}`)}`,
      },
    });
  });
  await context.addInitScript(
    ([key, value]) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    },
    [
      KEY,
      JSON.stringify({
        token: "github_pat_GROUPTEST",
        login: "maintainer-a",
        at: 1,
      }),
    ] as const,
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`thrown: ${error}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  let reads = 0;
  await page.route("**/state?*", async (route) => {
    const response = await route.fetch();
    const state = (await response.json()) as { value: StateAnswer };
    if (state.value.line !== null) state.value.line.needs = needs.current;
    reads++;
    await route.fulfill({ response, json: state });
  });
  await page.goto(`${server.url}&view=needs`);
  await shows(page, ".pNeeds .need");
  await settled(page);
  return { page, context, posted, problems, reads: () => reads };
}

function groupCard(page: Page) {
  return page.locator(".pNeeds .groupCard");
}

describe("a question group's card", () => {
  browserIt(
    "lists each target, sends one answer per target listed as the person, and a refused target becomes its own card",
    async () => {
      const needs = { current: stalledPickups() };
      const opened = await open(needs);
      const { page } = opened;
      try {
        const card = groupCard(page);
        expect(await card.count()).toBe(1);
        expect(await page.locator(".pNeeds .need").count()).toBe(1);
        const text = (await card.textContent()) ?? "";
        expect(text).toContain("3 items");
        expect(text).toContain(
          "How should the stalled pickup of each item go on?",
        );
        for (const n of ["#17", "#27", "#37"]) expect(text).toContain(n);
        // The act's heading counts needs, one per target.
        expect(
          await page
            .locator(".needGroupTitle [data-group-count]")
            .first()
            .textContent(),
        ).toBe("3");

        const repo = needs.current[0]?.repo ?? "";
        await card
          .getByRole("checkbox", { name: `Answer ${repo} #37` })
          .uncheck();
        expect(await card.textContent()).toContain("Left out: it stays open.");
        await card.locator(".opt").first().click();
        await page.clock.install();
        const send = card.getByRole("button", {
          name: "Send the answers for 3 items as maintainer-a",
        });
        await send.click();
        expect(opened.posted).toEqual([]);
        const guard = (await card.locator(".guard").textContent()) ?? "";
        expect(guard).toContain("each of 2 targets");
        expect(guard).toContain(`${repo} #17`);
        expect(guard).toContain(`${repo} #27`);
        expect(guard).not.toContain(`${repo} #37`);
        await card
          .getByRole("button", {
            name: "Confirm and send the answers for 3 items as maintainer-a",
          })
          .click();
        await until(
          "two answers posted",
          async () => opened.posted.length === 2,
        );
        expect(opened.posted.map((p) => p.path)).toEqual([
          `/repos/${repo}/issues/17/comments`,
          `/repos/${repo}/issues/27/comments`,
        ]);
        for (const [i, p] of opened.posted.entries()) {
          const digest = needs.current[i]?.decisions[0]?.digest;
          expect(withoutAnswerRecord(p.body).trim()).toBe(
            `answer pickup: approve [${digest}]`,
          );
          const record = decodeMarker(
            p.body,
            "jig-send-answer",
            "drive-answer",
          );
          assert(record.ok);
          expect(record.value.envelope.writer).toEqual({
            login: "maintainer-a",
            host: BROWSER_HOST,
          });
        }
        await until(
          "each sent target says so",
          async () =>
            (await card
              .locator(".groupTargetState", { hasText: "Sent here" })
              .count()) === 2,
        );

        // The tick carries out #17's answer and refuses #27's; #37 was left out and still waits.
        const [a, b, c] = needs.current as [LineNeed, LineNeed, LineNeed];
        const acted = (n: LineNeed, outcome: "done" | "refused"): LineNeed => ({
          ...n,
          decisions: n.decisions.map((d) => ({
            ...d,
            acted: {
              option: "Release the claim",
              author: "maintainer-a",
              outcome,
              detail: outcome === "refused" ? "the item moved since" : null,
            },
          })),
        });
        needs.current = [acted(a, "done"), acted(b, "refused"), c];
        const before = opened.reads();
        await page.clock.runFor(3_000);
        await until(
          "the next read splits off the refused target",
          async () =>
            opened.reads() > before &&
            (await page.locator(".pNeeds .need").count()) === 2,
        );
        const after = (await groupCard(page).textContent()) ?? "";
        expect(after).toContain("2 items");
        expect(after).toContain("carried out");
        expect(after).toContain("Left out: it stays open.");
        const own = page.locator(".pNeeds .need:not(.groupCard)", {
          hasText: "#27",
        });
        expect(await own.locator(".actedAnswer").textContent()).toContain(
          "refused — the item moved since",
        );
        expect(opened.problems).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "on a phone, by touch, lists its targets with full touch targets and no horizontal scroll",
    async () => {
      const opened = await open({ current: stalledPickups() }, PHONE);
      const { page } = opened;
      try {
        const card = groupCard(page);
        expect(await card.count()).toBe(1);
        expect(await card.locator(".groupTarget").count()).toBe(3);
        await card.locator(".groupPick").first().tap();
        expect(await card.textContent()).toContain("Left out: it stays open.");
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(0);
        expect(await shortControls(page)).toEqual([]);
        expect(opened.problems).toEqual([]);
      } finally {
        await opened.context.close();
      }
    },
    TIMEOUT,
  );
});
