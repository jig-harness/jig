/** A pull request body in memory for the deferred-section tests. */
import type {
  AnswerComment,
  PrBody,
  PrBodyForge,
} from "../scripts/lib/pr-body.ts";

export const PR_URL = "https://github.com/example/project/pull/42";

/** A pull request body in memory, with a hook that runs before each read. */
export function fakeForge(initial: string): PrBodyForge & {
  state: PrBody;
  beforeRead: Array<(s: PrBody) => void>;
  writes: number;
  answered: AnswerComment[];
  failWrites: boolean;
  /** The file each review thread is on, by its first comment. */
  paths: Map<string, string>;
  pathReads: number;
} {
  let clock = 0;
  const state: PrBody = {
    body: initial,
    updatedAt: "2026-10-29T00:00:00Z",
    url: PR_URL,
  };
  const forge = {
    state,
    beforeRead: [] as Array<(s: PrBody) => void>,
    writes: 0,
    answered: [] as AnswerComment[],
    failWrites: false,
    paths: new Map<string, string>(),
    pathReads: 0,
    async answers() {
      return forge.answered;
    },
    async threadPaths() {
      forge.pathReads += 1;
      return forge.paths;
    },
    async read() {
      forge.beforeRead.shift()?.(state);
      return { ...state };
    },
    async write(_pr: string, body: string) {
      if (forge.failWrites) throw new Error("the forge refused the write");
      forge.writes += 1;
      state.body = body;
      state.updatedAt = `2026-10-29T00:00:0${++clock}Z`;
    },
  };
  return forge;
}
