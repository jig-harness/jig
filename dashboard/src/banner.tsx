/**
 * What stands above the answer when the page cannot show it whole: the server
 * gone, the timer silent, a repository not read, a coded failure. A banner
 * leads with its title; what explains a short title shows on expanding.
 */
import { CopyButton } from "./copy.tsx";
import { Fold } from "./fold.tsx";
import { BareWord } from "./icon-word.tsx";
import type { IconWord } from "./icons.ts";

/** The command that starts the dashboard's server on the host. */
export const COMMAND = "jig dispatch dashboard";

function CommandRow() {
  return (
    <div className="copyRow">
      <span className="m sm">{COMMAND}</span>
      <CopyButton text={COMMAND} idle="Copy command" />
    </div>
  );
}

export function Banner({
  title,
  body,
  command,
  icon,
  detail,
}: {
  title: string;
  body: string;
  command: boolean;
  /** What the title is about, where the icon vocabulary draws it. */
  icon?: IconWord;
  /** The whole story behind a short title, shown on expanding. */
  detail?: string;
}) {
  return (
    <section className="banner" role="status">
      <span className="mk r-unknown" aria-hidden="true">
        ?
      </span>
      <div className="bannerBody">
        <h2>
          {icon === undefined ? title : <BareWord of={icon}>{title}</BareWord>}
        </h2>
        <p className="sm">{body}</p>
        {detail === undefined ? null : (
          <Fold label="What stopped the read">
            <p className="sm m">{detail}</p>
          </Fold>
        )}
        {command ? <CommandRow /> : null}
      </div>
    </section>
  );
}
