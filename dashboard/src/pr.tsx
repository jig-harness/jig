/** What a pull request's identity reads: its current forge state, the line it stands in, and the hover that opens its context (`work.tsx`). */
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  createContext,
  type PointerEvent,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { prStanding } from "./pr-standing.ts";
import type { Clock } from "./view.ts";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { reconcileNeeds } from "./pr-state.ts";
import { repoHome, withDerivedLinks } from "./links.ts";
import type { DashboardPr } from "../../plugin/dispatch/lib/dashboard-pr.ts";
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

export function usePrFact(repo: string, target: string) {
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
  return line === null ? null : reconcileNeeds(withDerivedLinks(line), facts);
}

/** A target's title under its key, as text its author wrote; nothing when no read gave one. */
export function ItemTitle({ title }: { title: string | null }) {
  return title === null ? null : <q className="sm itemTitle">{title}</q>;
}

export function RepoLink({ repo, url }: { repo: string; url?: string | null }) {
  const base = repoHome(repo, url);
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

const NO_CLOCK: Clock = { nowMs: 0, timeZone: "UTC" };

/** The line the page shows and its clock, which every PR's standing reads; before a line is read it holds neither. */
export const StandingSource = createContext<{
  line: LineSnapshot | null;
  clock: Clock;
}>({ line: null, clock: NO_CLOCK });

/** How long a mouse may take to cross the gap between the identity and its popup before the hint closes. */
const LEAVE_GRACE_MS = 300;

/** How soon after a hover opened a hint a click on its trigger still means "show it". */
const CLICK_AFTER_HOVER_MS = 400;

/** Opens a hint while a mouse rests anywhere on the element it spreads onto, and keeps it open while the mouse is on its popup; touch and keyboard use the hint's trigger. */
export function useMouseHover() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredAt = useRef(Number.NEGATIVE_INFINITY);
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
      hoveredAt.current = performance.now();
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
  // A click that follows the hover which opened the hint is the same wish to see it, not a toggle closed.
  const request = (next: boolean, reason?: string) => {
    if (
      !next &&
      reason === "trigger-press" &&
      performance.now() - hoveredAt.current < CLICK_AFTER_HOVER_MS
    )
      return;
    setOpen(next);
  };
  return { open, setOpen: request, hover };
}

/** What the page knows of one pull request: the line's story of it and the forge's read. */
export function useStanding(
  repo: string,
  pr: string,
  fact: DashboardPr | null,
) {
  const { line, clock } = useContext(StandingSource);
  return prStanding(line, repo, Number(pr), fact, clock);
}
