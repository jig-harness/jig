/**
 * The defect boundary: failed reads are values the page shows, so what reaches
 * here is a bug. It stays in the panel it happened in, as a plain line with a way
 * to copy it, and the other panels stay on the page.
 */
import { Component, type ReactNode } from "react";
import { CopyButton } from "./copy.tsx";

interface Props {
  /** The panel, as the line names it. */
  name: string;
  /** The panel's place in the page's grid. */
  className?: string;
  /** What the panel reads: a bug from one tick's data ends when newer data arrives. */
  reads: unknown;
  children: ReactNode;
}

export class PanelBoundary extends Component<Props, { bug: string | null }> {
  override state: { bug: string | null } = { bug: null };

  static getDerivedStateFromError(error: unknown): { bug: string } {
    return { bug: error instanceof Error ? error.message : String(error) };
  }

  override componentDidUpdate(previous: Props) {
    if (this.state.bug !== null && previous.reads !== this.props.reads)
      this.setState({ bug: null });
  }

  override render() {
    const { bug } = this.state;
    const { name, className, children } = this.props;
    if (bug === null) return children;
    const line = `${name} hit a bug and stopped here: ${bug}`;
    return (
      <section className={`panel ${className ?? ""}`}>
        <p className="defect">
          <span>{line}</span>
          <CopyButton text={line} aria={`Copy the bug in ${name}`} />
        </p>
      </section>
    );
  }
}
