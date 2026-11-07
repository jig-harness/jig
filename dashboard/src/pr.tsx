/** Shared PR identity: direct navigation, current forge state and hover/focus context. */
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  GitPullRequest,
  GitMerge,
  GitPullRequestClosed,
  CircleHelp,
} from "lucide-react";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { reconcileNeeds } from "./pr-state.ts";
import type { DashboardPr } from "../../plugin/dispatch/lib/dashboard-pr.ts";
import { CopyButton } from "./copy.tsx";
import { Hint } from "./fold.tsx";
import { prNumber } from "./pr-state.ts";

class PrReadError extends Error {}

function prQuery(repo: string, target: string) {
  const pr = prNumber(target);
  return {
    queryKey: ["pr", repo, pr],
    enabled: pr !== null,
    queryFn: async ({
      signal,
    }: {
      signal: AbortSignal;
    }): Promise<DashboardPr | null> => {
      const params = new URLSearchParams({
        repo,
        pr: pr ?? "",
        token: new URLSearchParams(location.search).get("token") ?? "",
      });
      const response = await fetch(`/pr?${params}`, { signal });
      if (!response.ok) throw new PrReadError("PR state unavailable");
      return await response.json();
    },
    staleTime: 60_000,
    retry: false,
  };
}

function usePrFact(repo: string, target: string) {
  const query = useQuery(prQuery(repo, target));
  return query.isError ? null : (query.data ?? null);
}

/** Read decisions even when their panel is collapsed; counts use the same fresh facts. */
function useNeedFacts(needs: Array<{ repo: string; target: string }>) {
  const unique = [
    ...new Map(needs.map((n) => [`${n.repo}#${n.target}`, n])).values(),
  ];
  const reads = useQueries({
    queries: unique.map((n) => prQuery(n.repo, n.target)),
  });
  const facts = new Map<string, DashboardPr>();
  reads.forEach((r, i) => {
    const n = unique[i];
    if (n && !r.isError && r.data)
      facts.set(`${n.repo}#${prNumber(n.target)}`, r.data);
  });
  return facts;
}

export function useCurrentLine(line: LineSnapshot | null) {
  const facts = useNeedFacts(line?.needs ?? []);
  return line === null ? null : reconcileNeeds(line, facts);
}

export function RepoLink({ repo, url }: { repo: string; url?: string | null }) {
  const base = url?.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+$/)?.[1];
  return base ? (
    <a
      className="m sm mut"
      href={base}
      target="_blank"
      rel="noreferrer noopener"
    >
      {repo}
    </a>
  ) : (
    <span className="m sm mut">{repo}</span>
  );
}

interface PrProps {
  repo: string;
  target: string;
  url: string | null;
  title?: string | null;
}

function TargetLink({ url, target }: Pick<PrProps, "url" | "target">) {
  if (url === null) return <span className="tgt">{target}</span>;
  return (
    <a className="tgt" href={url} target="_blank" rel="noreferrer noopener">
      {target}
    </a>
  );
}

function stateOf(fact: DashboardPr | null) {
  if (fact === null) return "Unknown";
  if (fact.state === "MERGED") return "Merged";
  if (fact.state === "CLOSED") return "Closed";
  return fact.isDraft ? "Draft" : "Open";
}

const STATE_ICONS = {
  Merged: GitMerge,
  Closed: GitPullRequestClosed,
  Unknown: CircleHelp,
  Draft: GitPullRequest,
  Open: GitPullRequest,
};

function PrContext({
  repo,
  target,
  url,
  title,
  fact,
  pr,
}: PrProps & { fact: DashboardPr | null; pr: string }) {
  const state = stateOf(fact);
  const Icon = STATE_ICONS[state];
  const freshness =
    fact === null
      ? "Current forge state unavailable. The tick and history may be stale."
      : `${state} · checked ${fact.checkedAt}`;
  return (
    <Hint
      className="prState"
      label={`PR #${pr}: ${state}`}
      trigger={
        <>
          <Icon size={14} aria-hidden="true" />
          {state}
        </>
      }
    >
      <strong>{fact?.title ?? title ?? target}</strong>
      <p>{freshness}</p>
      <p>
        <RepoLink repo={repo} url={url} /> #{pr}{" "}
        <CopyButton text={pr} aria={`Copy PR ID ${pr}`} />
      </p>
      {url === null ? null : (
        <a href={url} target="_blank" rel="noreferrer noopener">
          Open pull request
        </a>
      )}
    </Hint>
  );
}

export function Pr(props: PrProps) {
  const { repo, target, url } = props;
  const pr = prNumber(target);
  const fact = usePrFact(repo, target);
  const href = fact?.url ?? url;
  if (pr === null)
    return (
      <span className="tgt">
        <TargetLink url={url} target={target} />
        <CopyButton text={target} aria={`Copy ID ${target}`} />
      </span>
    );
  return (
    <span className={`prIdentity pr-${stateOf(fact).toLowerCase()}`}>
      <TargetLink url={href} target={target} />
      <PrContext {...props} url={href} fact={fact} pr={pr} />
      <CopyButton text={pr} aria={`Copy PR ID ${pr}`} />
    </span>
  );
}
