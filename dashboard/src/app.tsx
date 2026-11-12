import { FollowupSummary } from "./followups.tsx";
import { StandingSource, useCurrentLine } from "./pr.tsx";
/**
 * The page's views, one per question: Merge, Needs you, Running, Queue and
 * History, each one column of full-width cards and each tab with its count,
 * then Help. The page opens on Merge while merge now holds a pull request,
 * else on Needs you, and while merge now holds one every other view flashes
 * it. Keys and the palette reach every card (`keys.ts`, `palette.tsx`).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  LineSnapshot,
  RowsAnswer,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { receiptUrl } from "./api.ts";
import { PanelBoundary } from "./boundary.tsx";
import { tabCounts } from "./cards.ts";
import { ClipParts, CopyButton, KeyToast } from "./copy.tsx";
import { KeyBar } from "./key-bar.tsx";
import { Fold, Hint, PopupRoot } from "./fold.tsx";
import { hostDay } from "./format.ts";
import { HelpView } from "./help.tsx";
import { LinePanel } from "./line.tsx";
import { LogPanel } from "./log-panel.tsx";
import { type Forges, forgesOf } from "./links.ts";
import type { RowClock } from "./log-view.ts";
import { Strip } from "./marks.tsx";
import { MergeFlash, MergePanel, useFlash } from "./merge.tsx";
import { type FlashView, mergeNowCount } from "./merge-view.ts";
import { NeedsPanel } from "./needs.tsx";
import { answerBand, hasNeedRows } from "./needs-view.ts";
import { Palette } from "./palette.tsx";
import {
  lastReadLead,
  type PageView,
  pageFresh,
  pageView,
  readLine,
} from "./page-view.ts";
import { QueuePanel } from "./queue.tsx";
import {
  type Read,
  type StateRead,
  useRowsRead,
  useStateRead,
} from "./reads.ts";
import { Refused } from "./refused.tsx";
import { type Steering, useSteering, ViewFilter } from "./steering.tsx";
import { TicksPanel } from "./ticks.tsx";
import { bindAnswersToPark, forgetOldAnswers } from "./answers.ts";
import { useKeptToken } from "./forge-token.ts";
import { forgetOldSends } from "./sent.ts";
import { decisionRows } from "./picking.ts";
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
import { type Clock, staleBanners, timerBanner } from "./view.ts";
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
    const forget = () => {
      forgetOldAnswers(Date.now());
      forgetOldSends(Date.now());
    };
    forget();
    const timer = setInterval(forget, AGES_MOVE_MS);
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
  // A pick made before the line kept park times counts for the first park time seen, in whichever view that line arrives.
  useEffect(() => {
    if (line === null) return;
    bindAnswersToPark(
      line.needs.map((n) => ({
        repo: n.repo,
        target: n.target,
        rows: decisionRows(n.decisions),
      })),
    );
  }, [line]);
  // The opening view waits for the first answer: a failed first read must not settle it.
  const read = view.answer !== null;
  const [tab, setTabNow] = useView(
    read ? openingView(mergeNowCount(line)) : null,
  );
  const counts = tabCounts(line, clock, rows.data?.total ?? null);
  const [flash, dismissFlash] = useFlash(line);
  const main = useRef<HTMLElement | null>(null);
  const steer = useSteering(main, { line, clock, counts, setView: setTabNow });
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
                setView={steer.go}
                counts={counts}
                filter={filter}
                theme={theme}
              />
            }
            tools={<ThemeSwitch theme={theme} setTheme={setTheme} />}
          />
          <main className="main" ref={main}>
            <Banners view={view} />
            <ViewTop
              tab={tab}
              flash={tab === "merge" ? null : flash}
              mergeHref={hrefOf("merge", filter, theme)}
              onDismiss={dismissFlash}
              steer={steer}
              read={view.answer !== null}
            />
            <ViewBody
              tab={tab}
              view={view}
              log={rows.data}
              filter={filter}
              setFilter={setFilter}
              theme={theme}
            />
          </main>
          <footer className="foot">
            <Colophon view={view} token={token} />
          </footer>
          {steer.entries === null ? null : (
            <Palette
              entries={steer.entries}
              onRun={steer.runPalette}
              onClose={steer.closePalette}
            />
          )}
          <KeyBar />
          <KeyToast />
          <ClipParts />
        </StandingSource.Provider>
      </PopupRoot.Provider>
    </div>
  );
}

/** What stands above a view: the merge flash, and the filter over its cards. */
function ViewTop({
  tab,
  flash,
  mergeHref,
  onDismiss,
  steer,
  read,
}: {
  tab: ViewId;
  flash: FlashView | null;
  mergeHref: string;
  onDismiss: () => void;
  steer: Steering;
  read: boolean;
}) {
  return (
    <>
      {flash === null ? null : (
        <MergeFlash
          flash={flash}
          href={mergeHref}
          onGo={() => steer.goAndFocus("merge")}
          onDismiss={() => {
            onDismiss();
            steer.focusStart();
          }}
        />
      )}
      {FILTERED_VIEWS.has(tab) && read ? (
        <ViewFilter
          value={steer.cardQuery}
          setValue={steer.setCardQuery}
          shown={steer.shown}
        />
      ) : null}
    </>
  );
}

/** The view the tab names: Help, History, or one of the card views. */
function ViewBody({
  tab,
  view,
  log,
  filter,
  setFilter,
  theme,
}: {
  tab: ViewId;
  view: PageView;
  log: RowsAnswer | null;
  filter: LogFilter;
  setFilter: (patch: Partial<LogFilter>) => void;
  theme: Theme;
}) {
  const { line, clock } = view;
  const today = hostDay(clock.nowMs, clock.timeZone);
  const rowClock: RowClock = useMemo(
    () => ({ today, timeZone: clock.timeZone }),
    [today, clock.timeZone],
  );
  const forges = useMemo(() => forgesOf(line), [line]);
  if (tab === "help") return <HelpView Fold={Fold} />;
  if (view.answer === null) return null;
  if (tab !== "history") return <CardView tab={tab} view={view} log={log} />;
  return (
    <HistoryPanels
      theme={theme}
      view={view}
      log={log}
      filter={filter}
      setFilter={setFilter}
      rowClock={rowClock}
      forges={forges}
    />
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
      ) : line === null ? null : (
        staleBanners(line, view.clock).map((b) => (
          <Banner key={b.key} title={b.title} body={b.body} command={false} />
        ))
      )}
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
  const { kept } = useKeptToken();
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
      {line !== null && (hasNeedRows(line, clock.nowMs) || kept !== null) ? (
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

/** The footer's line: versions, the receipt, when the page read, and that it writes nothing to the host. */
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
        read-only for the host: this page sends it GET requests and writes
        nothing there; your theme, the answers you pick or draft and any GitHub
        token you paste stay in this browser, and Send posts to GitHub directly
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
