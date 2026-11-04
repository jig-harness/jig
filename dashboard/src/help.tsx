/**
 * Help: how to read the page, the words its panels use, and the legend, in one
 * view a person opens when something is unclear, so Now and History stay lean.
 */
import { type FoldComponent, Legend } from "./legend.tsx";
import { SOURCE_LEGEND, STAGE_LEGEND, stageMeaning, TERMS } from "./status.ts";

export function HelpView({ Fold }: { Fold: FoldComponent }) {
  return (
    <>
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
            <b>Now</b> answers what needs you, what is running on which account,
            and what is coming. <b>History</b> is the outcome log: one row per
            ended launch, filtered by time, repository, stage, account, class
            and reason. The filters are the page's address, so a view is a link.
          </p>
          <p>
            Words with a dotted underline, chips and the <b>?</b> beside a
            heading open a short explanation when hovered, tapped or focused.
          </p>
          <p>
            The page sends nothing to the host. To answer a parked decision,
            write a reply beside it (kept in this browser only), copy the
            answer, and paste it as a comment on the pull request; the next tick
            re-arms the drive.
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
