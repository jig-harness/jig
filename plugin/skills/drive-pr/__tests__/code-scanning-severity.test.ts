import { expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { summarizeAlert } from "../../resolve-review-comments/scripts/lib/code-scanning.ts";
import { parseCodeScanningSeverities } from "../../resolve-review-comments/scripts/lib/code-scanning-severity.ts";
import { sampleCodeScanningSeverity } from "../scripts/lib/sample-code-scanning.ts";
import {
  renderSeverityOutageWarnings,
  type LoopMetrics,
} from "../scripts/lib/metrics.ts";
import { severityOfRecord } from "../scripts/lib/record-labels.ts";

const body =
  "[Show more details](https://github.com/example/project/security/code-scanning/7)";
const repo = { owner: "example", name: "project" };
const thread = () => ({
  severity: "unknown",
  category: "unknown",
  startedBy: "github-advanced-security[bot]",
});

it("uses the alert for sampled metrics and triage alike", async () => {
  const raw = {
    rule: { security_severity_level: "high", severity: "warning" },
  };
  const sampled = thread();
  await sampleCodeScanningSeverity(sampled, body, repo, async () => raw);
  expect(sampled.severity).toBe("high");
  expect(sampled.severity).toBe(
    severityOfRecord({ codeScanning: summarizeAlert(7, raw) }),
  );
});
it("keeps an unreadable alert unknown even when its body looks like a severity", async () => {
  const sampled = { ...thread(), severity: "low" };
  await sampleCodeScanningSeverity(sampled, body, repo, async () => null);
  expect(sampled.severity).toBe("unknown");
});
it("does not fetch an alert linked by another author or repository", async () => {
  let calls = 0;
  await sampleCodeScanningSeverity(
    { ...thread(), startedBy: "someone" },
    body,
    repo,
    async () => {
      calls++;
      return {};
    },
  );
  await sampleCodeScanningSeverity(
    thread(),
    body,
    { owner: "other", name: "project" },
    async () => {
      calls++;
      return {};
    },
  );
  expect(calls).toBe(0);
});
it("overrides individual alert levels and rejects invalid mappings", () => {
  const mapping = parseCodeScanningSeverities({ high: "medium" });
  expect(mapping.high).toBe("medium");
  expect(mapping.error).toBe("high");
  expect(() => parseCodeScanningSeverities({ high: "unknown" })).toThrow();
  expect(() => parseCodeScanningSeverities({ typo: "low" })).toThrow();
});

it("never substitutes a comment token for an unreadable alert", () => {
  expect(
    severityOfRecord({
      codeScanning: { severity: "unknown" },
      comments: [
        {
          author: "coderabbitai[bot]",
          body: "**Security** | **Major** | **Quick win**",
        },
      ],
    }),
  ).toBe("unknown");
});
it("directs code-scanning outages to alert access rather than comment formats", () => {
  const metrics = {
    severityByAuthor: {
      "github-advanced-security[bot]": {
        unknown: 1,
        total: 1,
        unknownShare: 1,
        recentRoundKnown: false,
      },
    },
  } as unknown as LoopMetrics;
  const warning = renderSeverityOutageWarnings(metrics);
  expect(warning).toContain("code-scanning alert severity");
  expect(warning).not.toContain("severity_formats");
});

it("uses a repository override in the actual alert summarizer", () => {
  const path = join(
    import.meta.dir,
    "../../resolve-review-comments/scripts/lib/code-scanning.ts",
  );
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `import { summarizeAlert } from ${JSON.stringify(path)}; console.log(summarizeAlert(1, { rule: { security_severity_level: "high", severity: "error" } }).severity)`,
    ],
    {
      env: {
        ...process.env,
        JIG__review__code_scanning_severities: '{"high":"medium"}',
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expectSpawnExit(child, 0);
  expect(child.stdout.toString().trim()).toBe("medium");
});
