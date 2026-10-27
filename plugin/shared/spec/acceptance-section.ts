/**
 * The pull request's `## Acceptance` section: one line per acceptance
 * criterion the resolver found, saying how the pull request accounts for it.
 *
 * A criterion is `met` with the evidence record that shows it, `deferred`
 * with the tracker item that carries it, or `not applicable` with a reason.
 * One the pull request does not account for, or accounts for without its
 * evidence, item or reason, is `unaccounted`. The renderer only writes the
 * section; it refuses nothing.
 */
import type { Criterion } from "./resolve.ts";

export type CriterionAccount =
  | { state: "met"; evidence: string }
  | { state: "deferred"; item: string }
  | { state: "not applicable"; reason: string };

/** How a criterion is shown: its short id where that is unique, else its key. */
function label(c: Criterion, all: readonly Criterion[]): string {
  return all.filter((o) => o.id === c.id).length === 1 ? c.id : c.key;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The account given for `c`, by key, or by id where the id is unique. */
function accountOf(
  c: Criterion,
  all: readonly Criterion[],
  accounts: Readonly<Record<string, CriterionAccount>>,
): CriterionAccount | undefined {
  if (Object.hasOwn(accounts, c.key)) return accounts[c.key];
  return label(c, all) === c.id && Object.hasOwn(accounts, c.id)
    ? accounts[c.id]
    : undefined;
}

/** Per state: what its detail is called, what it is called when missing, and the detail. */
const DETAIL: {
  [S in CriterionAccount["state"]]: [
    string,
    string,
    (a: Extract<CriterionAccount, { state: S }>) => string,
  ];
} = {
  met: ["evidence", "evidence", (a) => a.evidence],
  deferred: ["deferred to", "an item", (a) => a.item],
  "not applicable": ["reason", "a reason", (a) => a.reason],
};

/** The state and its detail, or `unaccounted` with what is missing. */
function verdict(account: CriterionAccount | undefined): string {
  if (account === undefined) return "**unaccounted**";
  const [name, missing, read] = DETAIL[account.state] as [
    string,
    string,
    (a: CriterionAccount) => string,
  ];
  const value = oneLine(typeof read(account) === "string" ? read(account) : "");
  return value === ""
    ? `**unaccounted** (${account.state} without ${missing})`
    : `**${account.state}**; ${name}: ${value}`;
}

/** The section, heading included, for the criteria of a resolver result. */
export function renderAcceptanceSection(
  acceptance: readonly Criterion[],
  accounts: Readonly<Record<string, CriterionAccount>>,
): string {
  const lines = ["## Acceptance", ""];
  if (acceptance.length === 0) lines.push("No acceptance criteria resolved.");
  for (const c of acceptance)
    lines.push(
      `- \`${label(c, acceptance)}\` ${oneLine(c.text)}: ${verdict(accountOf(c, acceptance, accounts))}`,
    );
  return lines.join("\n");
}
