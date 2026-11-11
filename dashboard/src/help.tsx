/**
 * Help: the keys, how to read the page, the words its panels use, and the
 * legend, in one view a person opens when something is unclear, so the other
 * views stay lean.
 */
import { KEYS } from "./keys.ts";
import { type FoldComponent, Legend } from "./legend.tsx";
import { SOURCE_LEGEND, STAGE_LEGEND, stageMeaning, TERMS } from "./status.ts";

export function HelpView({ Fold }: { Fold: FoldComponent }) {
  return (
    <>
      <section className="panel pKeys" aria-labelledby="h-keys">
        <h2 id="h-keys" tabIndex={-1}>
          Keys
        </h2>
        <p className="sm mut">
          No key fires while you type in a field. j and k move one focus between
          the cards, so Tab still reaches every control.
        </p>
        <dl className="kv keyList">
          {KEYS.map((k) => (
            <div key={k.does} style={{ display: "contents" }}>
              <dt>
                {k.keys.map((key, i) => (
                  <span key={key}>
                    {i === 0 ? "" : " "}
                    <kbd>{key}</kbd>
                  </span>
                ))}
              </dt>
              <dd className="prose">{k.does}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="panel" aria-labelledby="h-reading">
        <h2 id="h-reading">Reading this page</h2>
        <div className="prose helpText">
          <p>
            The dispatcher runs on a timer. Each run, a <b>tick</b>, reads every
            repository, starts what it may, and writes what it found. This page
            shows what the newest tick found: the words at the top say how long
            ago that was, and hovering or tapping them says when the next tick
            is due. When the timer stops or the server stops answering, they
            turn into a warning.
          </p>
          <p>
            Each view answers one question, and its tab carries its count.{" "}
            <b>Merge</b> lists the converged pull requests by the act they ask,
            and only its merge now lane is safe to merge; while it holds one,
            every other view says so at its top. <b>Needs you</b> lists what
            only a person can settle. <b>Running</b> shows each account and the
            sessions holding its slots. <b>Queue</b> is what the next ticks will
            start, hold or report. <b>History</b> shows how the recent ticks
            ran, one row per tick with its slowest phase, and the outcome log:
            one row per ended launch, filtered by time, repository, stage,
            account, class and reason. The filters are the page's address, so a
            view is a link.
          </p>
          <p>
            Words with a dotted underline, chips and the <b>?</b> beside a
            heading open a short explanation when hovered, tapped or focused.
          </p>
          <p>
            The page writes nothing to the host. To answer a parked decision,
            pick an option on its row (1 is always the recommended one), add a
            note or write an answer in your own words, copy the card's answers
            and paste them as one comment on the pull request; the next tick
            re-arms the drive once every decision is answered. Picks stay in
            this browser only and can be undone; a decision framed again drops
            them and says so. A pick that asks for authorization, or of an
            option that cannot be undone, copies on the second step.
          </p>
        </div>
      </section>
      <section className="panel" aria-labelledby="h-words">
        <h2 id="h-words">Words</h2>
        <h3 className="helpHead">On accounts and sessions</h3>
        <dl className="kv">
          {TERMS.map((t) => (
            <div key={t.word} style={{ display: "contents" }}>
              <dt className="m">{t.word}</dt>
              <dd className="prose">{t.meaning}</dd>
            </div>
          ))}
        </dl>
        <h3 className="helpHead">Stages</h3>
        <dl className="kv">
          {STAGE_LEGEND.map((s) => (
            <div key={s.name} style={{ display: "contents" }}>
              <dt>
                <span className="chip">
                  <b>{s.mark}</b>
                  {s.name}
                </span>
              </dt>
              <dd className="prose">{stageMeaning(s.name)}</dd>
            </div>
          ))}
        </dl>
        <h3 className="helpHead">Where a coming item came from</h3>
        <dl className="kv">
          {SOURCE_LEGEND.map((s) => (
            <div key={s.name} style={{ display: "contents" }}>
              <dt>
                <span className="chip">{s.name}</span>
              </dt>
              <dd className="prose">{s.meaning}</dd>
            </div>
          ))}
        </dl>
      </section>
      <Legend Fold={Fold} stages={false} />
    </>
  );
}
