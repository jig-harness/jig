import type { LineLinks } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import type { ReactNode } from "react";
import { RepoLink } from "./pr.tsx";
import { WorkLead } from "./work.tsx";

/** The board facts shared by Ready-to-merge and Needs-you cards. */
export function BoardStatus({
  failing,
  failingOmitted = 0,
  unblocks,
}: {
  failing: string[];
  failingOmitted?: number;
  unblocks: number[];
}) {
  return (
    <>
      {failing.length === 0 ? null : (
        <p className="sm">
          Failing: {failing.join(", ")}
          {failingOmitted > 0 ? ` (+${failingOmitted} more)` : ""}.
        </p>
      )}
      {unblocks.length === 0 ? null : (
        <p className="sm">
          Unblocks {unblocks.map((n) => `#${n}`).join(", ")}.
        </p>
      )}
    </>
  );
}

/** The common identity row for a board card, with each view supplying its role markers. */
export function BoardCardLead({
  repo,
  target,
  url,
  title,
  links,
  age,
  action,
  children,
}: {
  repo: string;
  target: string;
  url: string;
  title: string;
  links?: LineLinks | undefined;
  age: string;
  action: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="rowTop">
      {children}
      <WorkLead
        repo={repo}
        target={target}
        url={url}
        title={title}
        links={links}
      />
      <span className="m sm mut end nowrap">{age}</span>
      <span className="br" />
      <RepoLink repo={repo} url={url} />
      {action === null ? null : <span className="chip">{action}</span>}
    </div>
  );
}
