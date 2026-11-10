/** Match live metrics to thread triage; historical samples have no alert snapshot. */
import {
  alertNumberOf,
  summarizeAlert,
} from "../../../resolve-review-comments/scripts/lib/code-scanning.ts";
import { swallow } from "../../../../shared/errors.ts";
import { ghCall } from "./proc.ts";

async function readRule(
  owner: string,
  repo: string,
  number: number,
): Promise<unknown> {
  const result = await ghCall([
    "api",
    `repos/${owner}/${repo}/code-scanning/alerts/${number}`,
  ]);
  if (result.code !== 0 || result.timedOut) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    swallow(
      error,
      "code-scanning alert rule could not be decoded; severity stays unknown",
    );
    return null;
  }
}

/** The author and same-repository details link establish which alert to read. */
export async function sampleCodeScanningSeverity(
  thread: { severity: string; category: string; startedBy: string | null },
  body: string,
  repo: { owner: string; name: string },
  read: typeof readRule = readRule,
): Promise<void> {
  const number = alertNumberOf(body, thread.startedBy, repo.owner, repo.name);
  if (number === null) return;
  const alert = summarizeAlert(
    number,
    await read(repo.owner, repo.name, number),
  );
  thread.severity = alert.severity;
  thread.category = alert.category;
}
