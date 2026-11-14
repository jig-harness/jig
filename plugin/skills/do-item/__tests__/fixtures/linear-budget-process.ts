/**
 * One process of the shared-budget test: a Linear HTTPS transport over the
 * budget store at `argv[2]`, with a fetch that answers as `argv[3]` says
 * (`refuse`: HTTP 400 with `RATELIMITED` and a reset `argv[4]`; `answer`: a
 * plain answer), sends one request, and prints how many reached the fetch
 * and how the request ended. `argv[5]`, when given, is the clock.
 */
import {
  budgetGovernor,
  isRateLimited,
  sqliteBudgetStore,
} from "../../../../shared/outbound/budget.ts";
import { withLedgerPath } from "../../../../shared/outbound/ledger.ts";
import { httpTransport } from "../../scripts/lib/tracker/linear-transport.ts";

const [store, mode, reset, clock] = process.argv.slice(2);
let fetches = 0;
const fetchImpl = (async () => {
  fetches += 1;
  const headers = {
    "x-ratelimit-requests-limit": "2500",
    "x-ratelimit-requests-remaining": mode === "refuse" ? "0" : "2400",
    "x-ratelimit-requests-reset": String(reset),
  };
  return mode === "refuse"
    ? new Response(
        JSON.stringify({
          errors: [
            { message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } },
          ],
        }),
        { status: 400, headers },
      )
    : new Response(JSON.stringify({ data: { viewer: { id: "u" } } }), {
        status: 200,
        headers,
      });
}) as unknown as typeof fetch;
const governor = budgetGovernor(sqliteBudgetStore(store as string), {
  ...(clock === undefined ? {} : { clock: () => Number(clock) }),
  share: () => null,
});
const transport = httpTransport("lin_api_test", fetchImpl, governor);
let ended: string;
try {
  await withLedgerPath(store as string, () => transport("query { viewer { id } }", {}));
  ended = "answered";
} catch (error) {
  ended = isRateLimited(error) ? `limited ${error.resetAt}` : String(error);
}
console.log(JSON.stringify({ fetches, ended }));
