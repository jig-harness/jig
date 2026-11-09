import { FollowupSummary } from "./followups.tsx";
import { StandingSource, useCurrentLine } from "./pr.tsx";
/**
 * The page's views, one per question: Merge, Needs you, Running, Queue and
 * History, each one column of full-width cards and each tab with its count,
 * then Help. The page opens on Merge while merge now holds a pull request,
 * else on Needs you, and while merge now holds one every other view flashes
 * it. Keys and the palette reach every card (`keys.ts`, `palette.tsx`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LineSnapshot,
  RowsAnswer,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { receiptUrl } from "./api.ts";
import { PanelBoundary } from "./boundary.tsx";
import { allCards } from "./cards.ts";
import {
  announce,
  ClipParts,
  CopyButton,
  copyText,
  KeyToast,
} from "./copy.tsx";
import { Fold, Hint, PopupRoot } from "./fold.tsx";
import { hostDay } from "./format.ts";
import { HelpView } from "./help.tsx";
import { cardsIn, focusCard, rove, useKeys } from "./keys.ts";
import { LinePanel } from "./line.tsx";
import { LogPanel } from "./log-panel.tsx";
import { type Forges, forgesOf, type RowClock } from "./log-view.ts";
import { Strip } from "./marks.tsx";
import { MergeFlash, MergePanel, useFlash } from "./merge.tsx";
import { mergeCount, mergeNowCount } from "./merge-view.ts";
import { NeedsPanel } from "./needs.tsx";
import { answerBand, hasNeedRows, needCount } from "./needs-view.ts";
import {
  Palette,
  type PaletteEntry,
  type PaletteRun,
  paletteEntries,
} from "./palette.tsx";
import {
  lastReadLead,
  type PageView,
  pageFresh,
  pageView,
  readLine,
} from "./page-view.ts";
import { QueuePanel } from "./queue.tsx";
import { queueGroups } from "./queue-view.ts";
import {
  type Read,
  type StateRead,
  useRowsRead,
  useStateRead,
} from "./reads.ts";
import { Refused } from "./refused.tsx";
import { TicksPanel } from "./ticks.tsx";
import { forgetOldReplies } from "./replies.ts";
import {
  FILTERED_VIEWS,
  type LogFilter,
  openingView,
  tokenOf,
  useFilter,
  useView,
  VIEWS,
  type ViewId,
  pageQuery,
  withParam,
} from "./search.ts";
import {
  nextTheme,
  schemeOf,
  type Theme,
  themeSearch,
  useTheme,
} from "./theme.ts";
import { type Clock, timerBanner } from "./view.ts";
import { WindowPanel } from "./window-panel.tsx";

const COMMAND = "jig dispatch dashboard";

/** How often ages move between reads. */
const AGES_MOVE_MS = 20_000;

/** This device's running clock, moving often enough for ages shown in minutes. */
function useMonoNow(): number {
  const [mono, setMono] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setMono(performance.now()), AGES_MOVE_MS);
    return () => clearInterval(timer);
  }, []);
  return mono;
}

function CommandRow() {
  return (
    <div className="copyRow">
      <span className="m sm">{COMMAND}</span>
      <CopyButton text={COMMAND} idle="Copy command" />
    </div>
  );
}

function Banner({
  title,
  body,
  command,
}: {
  title: string;
  body: string;
  command: boolean;
}) {
  return (
    <section className="banner" role="status">
      <span className="mk r-unknown" aria-hidden="true">
        ?
      </span>
      <div className="bannerBody">
        <h2>{title}</h2>
        <p className="sm">{body}</p>
        {command ? <CommandRow /> : null}
      </div>
    </section>
  );
}

export function App() {
  const [search] = useState(() => location.search);
  const token = useMemo(() => tokenOf(search), [search]);
  const [theme, setTheme] = useTheme();
  const scheme = schemeOf(theme);
  const [filter, setFilter] = useFilter();
  useEffect(() => {
    forgetOldReplies(Date.now());
    const timer = setInterval(() => forgetOldReplies(Date.now()), AGES_MOVE_MS);
    return () => clearInterval(timer);
  }, []);
  const state = useStateRead(token);
  const rows = useRowsRead(filter, token, state.data?.answer.timeZone ?? null);
  if (state.failure?.kind === "refused" || rows.failure?.kind === "refused")
    return (
      <Refused
        scheme={scheme}
        Fold={Fold}
        copyCommand={<CopyButton text={COMMAND} idle="Copy command" />}
      >
        <ClipParts />
      </Refused>
    );
  return (
    <Page
      token={token}
      theme={theme}
      setTheme={setTheme}
      filter={filter}
      setFilter={setFilter}
      state={state}
      rows={rows}
    />
  );
}

/** How fresh the page is, in a few words that open the facts behind them. */
function Freshness({ view }: { view: PageView }) {
  const fresh = pageFresh(view);
  return (
    <Hint
      className={fresh.alarm ? "fresh late" : "fresh"}
      label={`How fresh this page is: ${fresh.short}`}
      trigger={
        <>
          <span className="dot" aria-hidden="true" />
          {fresh.short}
        </>
      }
    >
      {fresh.detail.map((sentence) => (
        <p key={sentence}>{sentence}</p>
      ))}
    </Hint>
  );
}

const THEME_WORD: Record<Theme, string> = {
  auto: "Auto",
  light: "Light",
  dark: "Dark",
};

const THEME_GLYPH: Record<Theme, string> = { auto: "◐", light: "☀", dark: "☾" };

/** One button that moves the theme from the device's to light, dark and back. */
function ThemeSwitch({
  theme,
  setTheme,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}) {
  const next = nextTheme(theme);
  const says = `Theme: ${THEME_WORD[theme]}${theme === "auto" ? ", as the device" : ""}. Switch to ${THEME_WORD[next]}.`;
  return (
    <button
      className="themeBtn"
      type="button"
      aria-label={says}
      title={says}
      onClick={() => setTheme(next)}
    >
      <span aria-hidden="true">{THEME_GLYPH[theme]}</span>
      <span className="themeWord">{THEME_WORD[theme]}</span>
    </button>
  );
}

/** What each tab's count counts, said after it for a screen reader. */
const COUNTED: Partial<Record<ViewId, [string, string]>> = {
  merge: ["ready to merge", "ready to merge"],
  needs: ["needs you", "need you"],
  running: ["session", "sessions"],
  queue: ["coming", "coming"],
  history: ["row in the window", "rows in the window"],
};

/** The views, as links that keep the address, so one opens in a new tab too. */
function ViewNav({
  view,
  setView,
  counts,
  filter,
  theme,
}: {
  view: ViewId;
  setView: (view: ViewId) => void;
  counts: Partial<Record<ViewId, number>>;
  filter: LogFilter;
  theme: Theme;
}) {
  const nav = useRef<HTMLElement | null>(null);
  // On a phone the tabs scroll sideways; the current one is kept in sight.
  useEffect(() => {
    nav.current
      ?.querySelector(`[data-view="${view}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [view]);
  return (
    <nav className="views" aria-label="Views" ref={nav}>
      {VIEWS.map((v) => {
        const n = counts[v.id];
        const words = COUNTED[v.id];
        return (
          <a
            className={v.id === "help" ? "viewTab helpTab" : "viewTab"}
            key={v.id}
            data-view={v.id}
            href={hrefOf(v.id, filter, theme)}
            aria-current={v.id === view ? "page" : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              setView(v.id);
            }}
          >
            {v.label}
            {n === undefined || words === undefined ? null : (
              <>
                <span
                  className={
                    v.id === "needs" && n > 0 ? "badge" : "badge quiet"
                  }
                  aria-hidden="true"
                >
                  {n}
                </span>
                <span className="vh">
                  , {n} {n === 1 ? words[0] : words[1]}
                </span>
              </>
            )}
          </a>
        );
      })}
    </nav>
  );
}

/** A view's address: the one the page has, with the view changed. */
function hrefOf(view: ViewId, filter: LogFilter, theme: Theme): string {
  return pageQuery(
    filter,
    withParam(themeSearch(location.search, theme), "view", view),
  );
}

/** The filter over a view's cards, which `/` focuses and Escape clears. */
function ViewFilter({
  value,
  setValue,
  shown,
}: {
  value: string;
  setValue: (value: string) => void;
  shown: string | null;
}) {
  return (
    <div className="viewFilter">
      <input
        type="search"
        data-view-filter=""
        aria-label="Filter this view's cards"
        placeholder="Filter this view  /"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          setValue("");
          event.currentTarget.blur();
        }}
      />
      {shown === null ? null : <span className="sm mut">{shown}</span>}
    </div>
  );
}

/** Hides the cards whose text the filter does not find, and says how many it keeps. */
function useCardFilter(
  root: React.RefObject<HTMLElement | null>,
  query: string,
): string | null {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const apply = () => {
      const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w !== "");
      const cards = [...element.querySelectorAll<HTMLElement>("[data-card]")];
      for (const card of cards) {
        const text = card.textContent?.toLowerCase() ?? "";
        const keep = words.every((w) => text.includes(w));
        if (card.hidden === keep) card.hidden = !keep;
      }
      rove(element);
      const kept = cards.filter((c) => !c.hidden).length;
      const said =
        words.length === 0 ? null : `${kept} of ${cards.length} cards`;
      setShown((was) => (was === said ? was : said));
    };
    apply();
    const watcher = new MutationObserver(apply);
    watcher.observe(element, { childList: true, subtree: true });
    return () => watcher.disconnect();
  }, [root, query]);
  return shown;
}

function Page({
  token,
  theme,
  setTheme,
  filter,
  setFilter,
  state,
  rows,
}: {
  token: string;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  filter: LogFilter;
  setFilter: (patch: Partial<LogFilter>) => void;
  state: Read<StateRead>;
  rows: Read<RowsAnswer>;
}) {
  const [popupRoot, setPopupRoot] = useState<HTMLElement | null>(null);
  const snapshot = pageView(state, rows, useMonoNow());
  const view = {
    ...snapshot,
    line: useCurrentLine(snapshot.line),
  };
  const { line, clock } = view;
  const read = view.answer !== null || state.failure !== null;
  const [tab, setTabNow] = useView(
    read ? openingView(mergeNowCount(line)) : null,
  );
  const today = hostDay(clock.nowMs, clock.timeZone);
  const rowClock: RowClock = useMemo(
    () => ({ today, timeZone: clock.timeZone }),
    [today, clock.timeZone],
  );
  const forges = useMemo(() => forgesOf(line), [line]);
  const counts: Partial<Record<ViewId, number>> = {
    merge: mergeCount(line),
    needs: needCount(line, clock.nowMs),
    running: line?.sessions.length ?? 0,
    queue:
      line === null
        ? 0
        : queueGroups(line, clock).reduce((n, g) => n + g.items.length, 0),
    ...(rows.data === null ? {} : { history: rows.data.total }),
  };
  const [flash, dismissFlash] = useFlash(line);
  const main = useRef<HTMLElement | null>(null);
  const [cardQuery, setCardQuery] = useState("");
  const shown = useCardFilter(main, cardQuery);
  // What to focus once a view change has drawn: a card's key, or a selector.
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const setTab = useCallback(
    (next: ViewId) => {
      setCardQuery("");
      setTabNow(next);
    },
    [setTabNow],
  );
  const [palette, setPalette] = useState<HTMLElement | null>(null);
  // The entries are read once as the palette opens, so a read while it is open does not move its list.
  const [entries, setEntries] = useState<PaletteEntry[] | null>(null);
  const paletteOpen = entries !== null;
  useKeys(main, {
    setView: (next) => {
      setTab(next);
      if (next === "help") setFocusNext("#h-keys");
    },
    openPalette: () => {
      setPalette(
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      );
      setEntries(paletteEntries(allCards(line, clock), counts));
    },
    paletteOpen: () => paletteOpen,
    focusFilter: () => {
      const field = main.current?.querySelector<HTMLInputElement>(
        '[data-view-filter], .fields input[type="search"]',
      );
      if (field === null || field === undefined)
        announce("This view has no filter");
      else field.focus();
    },
  });
  useEffect(() => {
    const element = main.current;
    if (focusNext === null || element === null) return;
    const target = focusNext.startsWith("#")
      ? element.querySelector<HTMLElement>(focusNext)
      : (cardsIn(element).find((c) => c.dataset.card === focusNext) ?? null);
    if (target === null) return;
    setFocusNext(null);
    if (target.dataset.card === undefined) target.focus();
    else focusCard(element, target);
  });
  const runPalette = (run: PaletteRun) => {
    if (run.kind === "view") {
      setTab(run.view);
      if (run.view === "help") setFocusNext("#h-keys");
    } else if (run.kind === "card") {
      setTab(run.card.view);
      setFocusNext(run.card.key);
    } else if (run.card.command !== null) {
      const back = palette ?? main.current;
      if (back !== null) void copyText(run.card.command, back);
    }
  };
  return (
    <div
      className="dd"
      style={{ colorScheme: schemeOf(theme) }}
      ref={setPopupRoot}
    >
      <PopupRoot.Provider value={popupRoot}>
        <StandingSource.Provider value={{ line, clock }}>
          <Strip
            fresh={<Freshness view={view} />}
            alarm={pageFresh(view).alarm}
            nav={
              <ViewNav
                view={tab}
                setView={setTab}
                counts={counts}
                filter={filter}
                theme={theme}
              />
            }
            tools={<ThemeSwitch theme={theme} setTheme={setTheme} />}
          />
          <main className="main" ref={main}>
            <Banners view={view} />
            {flash === null || tab === "merge" ? null : (
              <MergeFlash
                flash={flash}
                href={hrefOf("merge", filter, theme)}
                onGo={() => setTab("merge")}
                onDismiss={dismissFlash}
              />
            )}
            {FILTERED_VIEWS.has(tab) && view.answer !== null ? (
              <ViewFilter
                value={cardQuery}
                setValue={setCardQuery}
                shown={shown}
              />
            ) : null}
            {tab === "help" ? (
              <HelpView Fold={Fold} />
            ) : view.answer === null ? null : tab === "history" ? (
              <HistoryPanels
                theme={theme}
                view={view}
                log={rows.data}
                filter={filter}
                setFilter={setFilter}
                rowClock={rowClock}
                forges={forges}
              />
            ) : (
              <CardView tab={tab} view={view} log={rows.data} />
            )}
          </main>
          <footer className="foot">
            <Colophon view={view} token={token} />
          </footer>
          {entries !== null ? (
            <Palette
              entries={entries}
              onRun={runPalette}
              onClose={() => {
                setEntries(null);
                const back = palette ?? main.current;
                if (back?.isConnected) back.focus();
              }}
            />
          ) : null}
          <KeyToast />
          <ClipParts />
        </StandingSource.Provider>
      </PopupRoot.Provider>
    </div>
  );
}

/** What stands above the answer: the server gone, the timer silent, a coded failure. */
function Banners({ view }: { view: PageView }) {
  const { line, coded } = view;
  const lead = lastReadLead(view);
  return (
    <>
      {view.gone ? (
        <Banner
          title="The server is not answering. This is what it last returned."
          body={`${lead}retrying every 60 s. It runs only while a person keeps it running: to start it again, run this on the host. Filters need the server and are off until it answers.`}
          command
        />
      ) : view.overdue && line !== null ? (
        <Banner {...timerBanner(line, view.clock)} command={false} />
      ) : null}
      {coded === null ? null : (
        <Banner
          title={coded.reason}
          body={`${coded.code}. ${lead}retrying every 60 s.`}
          command={false}
        />
      )}
    </>
  );
}

/** One of the card views, its panel behind its own defect boundary. */
function CardView({
  tab,
  view,
  log,
}: {
  tab: ViewId;
  view: PageView;
  log: RowsAnswer | null;
}) {
  const { line, clock } = view;
  if (tab === "merge")
    return (
      <PanelBoundary name="Ready to merge" className="pMerge" reads={line}>
        <MergePanel line={line} clock={clock} />
      </PanelBoundary>
    );
  if (tab === "running")
    return (
      <PanelBoundary name="What is running" className="pLine" reads={line}>
        <LinePanel line={line} clock={clock} />
      </PanelBoundary>
    );
  if (tab === "queue")
    return (
      <PanelBoundary name="What is coming" className="pQueue" reads={line}>
        <QueuePanel line={line} clock={clock} />
      </PanelBoundary>
    );
  return (
    <>
      <PanelBoundary name="The answer" reads={line}>
        <AnswerBand
          line={line}
          clock={clock}
          logHasRows={log?.logHasRows === true}
          pastTense={view.pastTense}
        />
      </PanelBoundary>
      {line !== null && hasNeedRows(line, clock.nowMs) ? (
        <PanelBoundary name="What needs you" className="pNeeds" reads={line}>
          <NeedsPanel line={line} clock={clock} />
        </PanelBoundary>
      ) : null}
    </>
  );
}

/** History: how the recent ticks ran, the window over the outcome log and the log itself. */
function HistoryPanels({
  theme,
  view,
  log,
  filter,
  setFilter,
  rowClock,
  forges,
}: {
  theme: Theme;
  view: PageView;
  log: RowsAnswer | null;
  filter: LogFilter;
  setFilter: (patch: Partial<LogFilter>) => void;
  rowClock: RowClock;
  forges: Forges;
}) {
  const { gone, line, clock } = view;
  return (
    <>
      <PanelBoundary name="How the ticks ran" className="pTicks" reads={line}>
        <TicksPanel line={line} clock={clock} />
      </PanelBoundary>
      {log?.logHasRows === true ? (
        <PanelBoundary name="Window" className="pWindow" reads={log}>
          <WindowPanel
            answer={log}
            filter={filter}
            setFilter={setFilter}
            offline={gone}
            rowClock={rowClock}
          />
        </PanelBoundary>
      ) : null}
      <PanelBoundary name="How it went" reads={log}>
        <LogPanel
          theme={theme}
          answer={log}
          filter={filter}
          setFilter={setFilter}
          offline={gone}
          rowClock={rowClock}
          forges={forges}
        />
      </PanelBoundary>
    </>
  );
}

/** The footer's line: versions, the receipt, when the page read, and that it writes nothing. */
function Colophon({ view, token }: { view: PageView; token: string }) {
  const { answer, version, line } = view;
  return (
    <div className="colophon m">
      <span>this host</span>
      {version === null || answer === null ? null : (
        <>
          <span>{version}</span>
          <span>database schema {answer.schema}</span>
          <CopyButton
            text={`${version}, database schema ${answer.schema}`}
            idle="Copy versions"
          />
        </>
      )}
      {line === null ? null : (
        <>
          <a href={receiptUrl(token, line.runId)}>receipt {line.runId}</a>
          <CopyButton text={line.runId} idle="Copy receipt id" />
        </>
      )}
      <span>{readLine(view)}</span>
      <span>
        read-only: this page sends GET requests and writes nothing to the host;
        your theme and reply drafts stay in this browser
      </span>
    </div>
  );
}

function AnswerBand({
  line,
  clock,
  logHasRows,
  pastTense,
}: {
  line: LineSnapshot | null;
  clock: Clock;
  logHasRows: boolean;
  pastTense: boolean;
}) {
  const view = answerBand(line, clock, logHasRows, pastTense);
  return (
    <section
      className={view.loud ? "answer loud" : "answer"}
      aria-label="Does anything need a person"
    >
      <h1>{view.title}</h1>
      <p className="sm">{view.sub}</p>
      <FollowupSummary line={line} nowMs={clock.nowMs} />
    </section>
  );
}
