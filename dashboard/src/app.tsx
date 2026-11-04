/**
 * The page, in three views. Now keeps the question order, its top half reshaped
 * by state: with nothing to do the answer is a plain line and what is running
 * takes the wide column; with something to do a filled band appears and the wide
 * column belongs to the person. History is the outcome log; Help says how to
 * read the rest.
 */
import { useEffect, useMemo, useState } from "react";
import type {
  LineSnapshot,
  RowsAnswer,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { receiptUrl } from "./api.ts";
import { PanelBoundary } from "./boundary.tsx";
import { ClipParts, CopyButton } from "./copy.tsx";
import { Fold, Hint, PopupRoot } from "./fold.tsx";
import { hostDay } from "./format.ts";
import { HelpView } from "./help.tsx";
import { LinePanel } from "./line.tsx";
import { LogPanel } from "./log-panel.tsx";
import { type Forges, forgesOf, type RowClock } from "./log-view.ts";
import { Strip } from "./marks.tsx";
import { NeedsPanel } from "./needs.tsx";
import { answerBand, hasNeedRows, needRows } from "./needs-view.ts";
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
import { forgetOldReplies } from "./replies.ts";
import {
  type LogFilter,
  tokenOf,
  useFilter,
  useView,
  VIEWS,
  type ViewId,
  pageQuery,
  withParam,
} from "./search.ts";
import { nextTheme, schemeOf, type Theme, useTheme } from "./theme.ts";
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
  useEffect(() => forgetOldReplies(Date.now()), []);
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
      label="How fresh this page is"
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

/** The views, as links that keep the address, so one opens in a new tab too. */
function ViewNav({
  view,
  setView,
  needs,
  filter,
}: {
  view: ViewId;
  setView: (view: ViewId) => void;
  /** How many rows need a person, which the Now tab carries. */
  needs: number;
  filter: LogFilter;
}) {
  return (
    <nav className="views" aria-label="Views">
      {VIEWS.map((v) => (
        <a
          className="viewTab"
          key={v.id}
          href={hrefOf(v.id, filter)}
          aria-current={v.id === view ? "page" : undefined}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            setView(v.id);
          }}
        >
          {v.label}
          {v.id === "now" && needs > 0 ? (
            <>
              <span className="badge" aria-hidden="true">
                {needs}
              </span>
              <span className="vh">, {needs} need you</span>
            </>
          ) : null}
        </a>
      ))}
    </nav>
  );
}

/** A view's address: the one the page has, with the view changed. */
function hrefOf(view: ViewId, filter: LogFilter): string {
  return pageQuery(
    filter,
    withParam(location.search, "view", view === "now" ? null : view),
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
  const [tab, setTab] = useView();
  const view = pageView(state, rows, useMonoNow());
  const { line, clock } = view;
  const needs =
    line === null
      ? 0
      : needRows(line, clock).filter((row) => row.type !== "head").length;
  const today = hostDay(clock.nowMs, clock.timeZone);
  const rowClock: RowClock = useMemo(
    () => ({ today, timeZone: clock.timeZone }),
    [today, clock.timeZone],
  );
  const forges = useMemo(() => forgesOf(line), [line]);
  return (
    <div
      className="dd"
      style={{ colorScheme: schemeOf(theme) }}
      ref={setPopupRoot}
    >
      <PopupRoot.Provider value={popupRoot}>
        <Strip
          fresh={<Freshness view={view} />}
          alarm={pageFresh(view).alarm}
          nav={
            <ViewNav
              view={tab}
              setView={setTab}
              needs={needs}
              filter={filter}
            />
          }
          tools={<ThemeSwitch theme={theme} setTheme={setTheme} />}
        />
        <main className="main">
          <Banners view={view} />
          {tab === "help" ? (
            <HelpView Fold={Fold} />
          ) : view.answer === null ? null : tab === "history" ? (
            <HistoryPanels
              view={view}
              log={rows.data}
              filter={filter}
              setFilter={setFilter}
              rowClock={rowClock}
              forges={forges}
            />
          ) : (
            <NowPanels view={view} log={rows.data} />
          )}
        </main>
        <footer className="foot">
          <Colophon view={view} token={token} />
        </footer>
        <ClipParts />
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

/** Now: the answer and the panels in the grid, each behind its own defect boundary. */
function NowPanels({ view, log }: { view: PageView; log: RowsAnswer | null }) {
  const { line, clock } = view;
  const loud = hasNeedRows(line, clock.nowMs);
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
      <div className={`grid ${loud ? "loud" : "quiet"}`}>
        {line !== null && loud ? (
          <PanelBoundary name="What needs you" className="pNeeds" reads={line}>
            <NeedsPanel line={line} clock={clock} />
          </PanelBoundary>
        ) : null}
        <PanelBoundary name="What is running" className="pLine" reads={line}>
          <LinePanel line={line} clock={clock} />
        </PanelBoundary>
        <PanelBoundary name="What is coming" className="pQueue" reads={line}>
          <QueuePanel line={line} clock={clock} />
        </PanelBoundary>
      </div>
    </>
  );
}

/** History: the window over the outcome log and the log itself. */
function HistoryPanels({
  view,
  log,
  filter,
  setFilter,
  rowClock,
  forges,
}: {
  view: PageView;
  log: RowsAnswer | null;
  filter: LogFilter;
  setFilter: (patch: Partial<LogFilter>) => void;
  rowClock: RowClock;
  forges: Forges;
}) {
  const { gone } = view;
  return (
    <>
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
    </section>
  );
}
