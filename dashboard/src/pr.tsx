/** Shared PR identity: direct navigation, current forge state and hover/focus context. */
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  CircleAlert,
  Clock as ClockIcon,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  ListChecks,
  ListOrdered,
  type LucideIcon,
  Pause,
} from "lucide-react";
import {
  createContext,
  type PointerEvent,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { prStanding, type Standing, type StandingKind } from "./pr-standing.ts";
import type { Clock } from "./view.ts";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { reconcileNeeds } from "./pr-state.ts";
import type { DashboardPr } from "../../plugin/dispatch/lib/dashboard-pr.ts";
import { CopyButton } from "./copy.tsx";
import { Hint } from "./fold.tsx";
import { prNumber } from "./pr-state.ts";

class PrReadError extends Error {}

function prParams(repo: string, pr: string | null) {
  return new URLSearchParams({
    repo,
    pr: pr ?? "",
    token: new URLSearchParams(location.search).get("token") ?? "",
  });
}

function prQuery(repo: string, target: string) {
  const pr = prNumber(target);
  return {
    queryKey: ["pr", repo, pr],
    enabled: pr !== null,
    queryFn: async ({
      signal,
    }: {
      signal: AbortSignal;
    }): Promise<DashboardPr> => {
      const response = await fetch(`/pr?${prParams(repo, pr)}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new PrReadError("PR state unavailable");
      const fact: DashboardPr | null = await response.json();
      if (fact === null) throw new PrReadError("PR state unavailable");
      return fact;
    },
    staleTime: 60_000,
    retry: false,
  };
}

function usePrFact(repo: string, target: string) {
  const query = useQuery(prQuery(repo, target));
  return query.data ?? null;
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
    if (n && r.data) facts.set(`${n.repo}#${prNumber(n.target)}`, r.data);
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

const NO_CLOCK: Clock = { nowMs: 0, timeZone: "UTC" };

/** The line the page shows and its clock, which every PR's standing reads; before a line is read it holds neither. */
export const StandingSource = createContext<{
  line: LineSnapshot | null;
  clock: Clock;
}>({ line: null, clock: NO_CLOCK });

const KIND_ICONS: Record<StandingKind, LucideIcon> = {
  driving: GitPullRequestArrow,
  "following-up": ListChecks,
  waiting: ClockIcon,
  "needs-person": CircleAlert,
  queued: ListOrdered,
  held: Pause,
  merged: GitMerge,
  closed: GitPullRequestClosed,
  draft: GitPullRequestDraft,
  open: GitPullRequest,
  unknown: GitPullRequest,
};

function StandingBody({
  standing,
  Icon,
}: {
  standing: Standing;
  Icon: LucideIcon;
}) {
  return (
    <>
      <p className={`prLabel tone-${standing.tone}`}>
        <Icon size={14} aria-hidden="true" /> {standing.label}
      </p>
      <ul className="prFacts">
        {standing.facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </>
  );
}

function OpenLink({ url }: { url: string | null }) {
  return url === null ? null : (
    <a href={url} target="_blank" rel="noreferrer noopener">
      Open pull request
    </a>
  );
}

function PrContext({
  repo,
  target,
  url,
  title,
  fact,
  pr,
  standing,
  open,
  setOpen,
}: PrProps & {
  fact: DashboardPr | null;
  pr: string;
  standing: Standing;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const Icon = KIND_ICONS[standing.kind];
  return (
    <Hint
      className={`prState tone-${standing.tone}`}
      label={`PR #${pr}: ${standing.label}`}
      open={open}
      onOpenChange={setOpen}
      trigger={<Icon size={16} aria-hidden="true" />}
    >
      <strong>{fact?.title ?? title ?? target}</strong>
      <StandingBody standing={standing} Icon={Icon} />
      <p>
        <RepoLink repo={repo} url={url} /> #{pr}{" "}
        <CopyButton text={pr} aria={`Copy PR ID ${pr}`} />
      </p>
      <OpenLink url={url} />
    </Hint>
  );
}

function useStanding(repo: string, pr: string, fact: DashboardPr | null) {
  const { line, clock } = useContext(StandingSource);
  return prStanding(line, repo, Number(pr), fact, clock);
}

/** How long a mouse may take to cross the gap between the identity and its popup before the hint closes. */
const LEAVE_GRACE_MS = 300;

/** Opens a hint while a mouse rests anywhere on the element it spreads onto, and keeps it open while the mouse is on its popup; touch and keyboard use the hint's trigger. */
function useMouseHover() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const hover = {
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse") return;
      cancel();
      setOpen(true);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse") return;
      cancel();
      timer.current = setTimeout(() => {
        if (document.querySelector(".popPos:hover") === null) setOpen(false);
      }, LEAVE_GRACE_MS);
    },
  };
  return { open, setOpen, hover };
}

function NumberedPr(props: PrProps & { pr: string }) {
  const { repo, target, url, pr } = props;
  const fact = usePrFact(repo, target);
  const { open, setOpen, hover } = useMouseHover();
  const standing = useStanding(repo, pr, fact);
  const href = fact?.url ?? url;
  return (
    <span className={`prIdentity pr-${standing.kind}`} {...hover}>
      <PrContext
        {...props}
        url={href}
        fact={fact}
        standing={standing}
        open={open}
        setOpen={setOpen}
      />
      <TargetLink url={href} target={target} />
      <CopyButton text={pr} aria={`Copy PR ID ${pr}`} />
    </span>
  );
}

export function Pr(props: PrProps) {
  const pr = prNumber(props.target);
  if (pr !== null) return <NumberedPr {...props} pr={pr} />;
  return (
    <span className="tgt">
      <TargetLink url={props.url} target={props.target} />
      <CopyButton text={props.target} aria={`Copy ID ${props.target}`} />
    </span>
  );
}
