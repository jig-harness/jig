/**
 * The page: one question order, whose top half reshapes by state. With nothing to
 * do the answer is a plain line and the log takes the wide column; with something
 * to do a filled band appears and the wide column belongs to the person.
 */
import { useEffect, useMemo, useState } from "react";
import type {
  LineSnapshot,
  RowsAnswer,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { receiptUrl } from "./api.ts";
import { PanelBoundary } from "./boundary.tsx";
import { ClipParts, CopyButton } from "./copy.tsx";
import { Fold, PopupRoot } from "./fold.tsx";
import { hostDay } from "./format.ts";
import { Legend } from "./legend.tsx";
import { LinePanel } from "./line.tsx";
import { LogPanel } from "./log-panel.tsx";
import { type Forges, forgesOf, type RowClock } from "./log-view.ts";
import { Strip } from "./marks.tsx";
import { NeedsPanel } from "./needs.tsx";
import { answerBand, hasNeedRows } from "./needs-view.ts";
import {
  lastReadLead,
  type PageView,
  pageStrip,
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
import { type LogFilter, schemeOf, tokenOf, useFilter } from "./search.ts";
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
  const scheme = useMemo(() => schemeOf(search), [search]);
  const [filter, setFilter] = useFilter();
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
      scheme={scheme}
      filter={filter}
      setFilter={setFilter}
      state={state}
      rows={rows}
    />
  );
}

function Page({
  token,
  scheme,
  filter,
  setFilter,
  state,
  rows,
}: {
  token: string;
  scheme: string;
  filter: LogFilter;
  setFilter: (patch: Partial<LogFilter>) => void;
  state: Read<StateRead>;
  rows: Read<RowsAnswer>;
}) {
  const [popupRoot, setPopupRoot] = useState<HTMLElement | null>(null);
  const view = pageView(state, rows, useMonoNow());
  const { line, clock } = view;
  const today = hostDay(clock.nowMs, clock.timeZone);
  const rowClock: RowClock = useMemo(
    () => ({ today, timeZone: clock.timeZone }),
    [today, clock.timeZone],
  );
  const forges = useMemo(() => forgesOf(line), [line]);
  return (
    <div className="dd" style={{ colorScheme: scheme }} ref={setPopupRoot}>
      <PopupRoot.Provider value={popupRoot}>
        <Strip {...pageStrip(view)} version={view.version} />
        <main className="main">
          <Banners view={view} />
          {view.answer === null ? null : (
            <Panels
              view={view}
              log={rows.data}
              filter={filter}
              setFilter={setFilter}
              rowClock={rowClock}
              forges={forges}
            />
          )}
        </main>
        <footer className="foot">
          <Legend Fold={Fold} />
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

/** The answer, the panels in the grid, and the log, each behind its own defect boundary. */
function Panels({
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
  const { line, clock, gone } = view;
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
        <PanelBoundary name="The line" className="pLine" reads={line}>
          <LinePanel line={line} clock={clock} />
        </PanelBoundary>
        <PanelBoundary name="What is coming" className="pQueue" reads={line}>
          <QueuePanel line={line} clock={clock} />
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
      </div>
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
          <a href={receiptUrl(token)}>receipt {line.runId}</a>
          <CopyButton text={line.runId} idle="Copy receipt id" />
        </>
      )}
      <span>{readLine(view)}</span>
      <span>
        read-only: this page sends GET requests and writes nothing; Copy touches
        only your clipboard
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
