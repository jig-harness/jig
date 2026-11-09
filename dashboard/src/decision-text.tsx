/**
 * The whole decision, rendered from the Markdown a drive recorded. The text comes
 * from pull requests, so nothing in it may run or reach anywhere by itself: raw
 * HTML stays text, an image shows its description, and only a web or mail link
 * becomes a link, opening away from this page without saying where it came from.
 */
import {
  Markdown,
  type MarkdownComponentProps,
} from "@tanstack/markdown/react";

const LINKABLE = /^(?:https?:\/\/|mailto:)/i;

function DecisionLink({ href, children }: MarkdownComponentProps<"a">) {
  return href !== undefined && LINKABLE.test(href) ? (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

function DecisionImage({ alt }: MarkdownComponentProps<"img">) {
  return <span>{alt}</span>;
}

const COMPONENTS = { a: DecisionLink, img: DecisionImage };

export function DecisionText({
  source,
  lines = false,
}: {
  source: string;
  /** Whether a line break in the text stays one, for text a person did not write as Markdown. */
  lines?: boolean;
}) {
  return (
    <div className={lines ? "quote md lines" : "quote md"}>
      <Markdown components={COMPONENTS}>{source}</Markdown>
    </div>
  );
}
