import { claimForgeSlot } from "../../outbound/forge-pacing.ts";
import { budgetGovernor, memoryBudgetStore } from "../../outbound/budget.ts";
import { githubCredential, setForgeGovernor } from "../../outbound/github-budget.ts";
import { setDefaultLedgerPath } from "../../outbound/ledger.ts";
import { currentMs } from "../../time.ts";
import { traceGhRunner, unheldForm } from "../../trace.ts";
import type { OutboundFailure } from "../../outbound/failure.ts";
import { writeFileSync } from "node:fs";
import { holdUnanswered } from "../../outbound/hold.ts";
import { systemClock } from "../../clock.ts";

const [path, scenario] = process.argv.slice(2);
if (!path || !scenario) process.exit(2);
setDefaultLedgerPath(path);
const env = { GH_TOKEN: "pacing-fixture-token", JIG_FORGE_BUDGET: "on" };
const key = githubCredential(env);
const store = memoryBudgetStore();
const governor = budgetGovernor(store, { share: () => null });
let admissions = 0;
setForgeGovernor({
  ...governor,
  admit(...args) { admissions += 1; return governor.admit(...args); },
});
const controller = new AbortController();
const sends: number[] = [];
const probe = Promise.withResolvers<void>();
const raw = traceGhRunner(
  async (_args: string[], opts: { env: Record<string, string>; signal?: AbortSignal; timeoutSec?: number }) => {
    sends.push(opts.timeoutSec ?? 0);
    if (scenario.startsWith("probe-")) await probe.promise;
    return {
      code: scenario === "secondary" || scenario === "primary" ? 1 : 0,
      stdout: scenario === "secondary"
        ? "HTTP/2.0 403 Forbidden\nRetry-After: 120\n\n{}"
        : scenario === "primary"
          ? `HTTP/2.0 403 Forbidden\nX-Ratelimit-Resource: core\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${Math.floor(currentMs() / 1000) + 600}\n\n{}`
          : "{}",
      stderr: scenario === "secondary" ? "gh: secondary rate limit (HTTP 403)" : scenario === "primary" ? "gh: API rate limit exceeded (HTTP 403)" : "",
      timedOut: false,
      held: undefined as OutboundFailure | undefined,
    };
  },
  () => 10,
  { env, signal: controller.signal, timeoutSec: 1 },
  (failure) => ({ code: 1, stdout: "", stderr: failure.reason, timedOut: false, held: failure }),
);
const run = unheldForm(raw) ?? raw;
if (scenario.startsWith("probe-")) {
  const holdPath = path + ".hold";
  writeFileSync(holdPath, JSON.stringify({ github: { at: "2026-01-01T00:00:00.000Z", reason: "previous outage" } }));
  holdUnanswered(holdPath);
  const first = raw(["api", "repos/example/repository"], { env, timeoutSec: 3 });
  const deadline = currentMs() + 2000;
  while (sends.length === 0 && currentMs() < deadline) await systemClock.sleep(5);
  if (sends.length !== 1) process.exit(5);
  const second = raw(["api", "repos/example/repository"], { env, signal: controller.signal, timeoutSec: 1 });
  if (scenario === "probe-cancel") controller.abort();
  const result = await second;
  const countBeforeRelease = sends.length;
  probe.resolve();
  await first;
  console.log(JSON.stringify({ sends, countBeforeRelease, admissions, result }));
} else if (scenario === "cancel" || scenario === "changed-budget") {
  const claim = claimForgeSlot(key, currentMs(), path);
  if (!claim.ok || claim.value !== 0) process.exit(4);
  const pending = run(["api", "repos/example/repository"]);
  const before = admissions;
  if (scenario === "cancel") controller.abort();
  else governor.observe(key, { limitedUntil: currentMs() + 120_000, why: "refused while queued" });
  const result = await pending;
  console.log(JSON.stringify({ sends, before, admissions, result }));
} else {
  const first = await run(["api", "repos/example/repository"]);
  const second = await run(["api", "repos/example/repository"]);
  console.log(JSON.stringify({ sends, admissions, first, second, now: currentMs() }));
}
