/** Lifecycle evidence is separate from age and from authority to remove. */
export type KindName = "worktrees" | "tool-state" | "scratch" | "receipts";
export type Outcome =
  | "collected"
  | "would-collect"
  | "refused"
  | "finding"
  | "unverified"
  | "failed";
export interface Resource {
  id: string;
  bytes?: number;
  details?: unknown;
}
export interface Proof {
  state: "dead" | "live" | "finding" | "unverified";
  reason: string;
  /** Missing creator coordination is an explicit collection veto. */
  reportOnly?: string;
}
export interface CollectionKind {
  name: KindName;
  repository?: string;
  declaration: string;
  inventory(): Promise<Resource[]>;
  prove(resource: Resource): Promise<Proof>;
  collect(resource: Resource): Promise<{
    outcome: "collected" | "refused" | "failed";
    reason: string;
    details?: unknown;
  }>;
  describe(resource: Resource): string;
  exclusive<T>(body: () => Promise<T>): Promise<T>;
}
export interface ReceiptLine {
  kind: KindName;
  repository?: string;
  resource: string;
  description: string;
  outcome: Outcome;
  reason: string;
  proof?: string;
  details?: unknown;
  bytes?: number;
}
export interface Receipt {
  version: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  collect: boolean;
  completed: boolean;
  kinds: { name: KindName; repository?: string; declaration: string }[];
  resources: ReceiptLine[];
  exitStatus: number;
}
