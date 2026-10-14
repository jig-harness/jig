#!/usr/bin/env bun
// Promote-safety lint: a production deploy path must be gated and verified.
//
// The problem it catches. "Deploy only verified artifacts, and only on a human's
// say-so" is a promise the deploy WORKFLOW has to keep. These wiring mistakes
// break it silently:
//   (a) the production deploy fires automatically on a branch push, with no
//       manual gate or environment approval — so any merge ships to prod, and a
//       bad merge reaches users before anyone looks; and
//   (b) the production deploy ships a MUTABLE ref (a moving branch, HEAD, an
//       `:latest` image) instead of the pinned `verified` pointer/artifact — so
//       what reaches prod is whatever the branch happens to be, not the thing
//       that actually passed verification; and
//   (c) a job of the promotion looks its commit up again by name instead of
//       taking the one the gate approved from the job before it — so the
//       commit it ships can differ from the commit the gate checked.
// This lint scans a workflows directory and fails a production-deploy workflow
// that commits any of these mistakes, so the safe wiring can't quietly regress.
//
// Scoped to the DEPLOY JOB, not the file. A workflow has many jobs; the checks
// apply to the job that actually deploys to production, so a gate or a
// `verified` reference on some OTHER job (a preview deploy with its own
// environment, a build job that checks out the verified ref) can't mask an
// unsafe production job. The lint segments the workflow into jobs (GitHub
// Actions `jobs:` children; GitLab top-level jobs) and evaluates each
// production-deploy job — one that carries BOTH a deploy signal (`deploy`) and a
// production signal (`prod`/`production`) — on its own.
//
// What trips it — a production-deploy JOB where:
//   (a) it fires on `push` — a GitHub Actions `on: push` (bare or quoted scalar,
//       flow sequence [push], a block-sequence item `- push`, block `push:`, or
//       an inline `on: { push: ... }` mapping), or a GitLab push rule
//       (`$CI_PIPELINE_SOURCE == "push"`, or legacy `only: pushes`), including a
//       rule inside the job — AND that job has no gate on the push run: no
//       `environment:` key (where GitHub/GitLab environment protection lives) and
//       no GitLab `when: manual` (a real `when` property of a GitLab job or rule,
//       not text in a command or block scalar; it never gates a GitHub
//       workflow). Bare and quoted keys are both recognized. A
//       `workflow_dispatch` trigger does NOT count:
//       it is an additional trigger, not an approval on the push run; OR
//   (b) that job selects a mutable ref (a `ref:` or `--ref` of
//       main/master/develop/HEAD, a `github.ref`/`github.ref_name`, or an
//       `@latest`/`:latest` tag) at all. A
//       line matcher cannot prove WHICH line is the deploy command, so a
//       `verified` reference elsewhere in the same job (a build download, a
//       tooling checkout) does NOT clear it — a mutable ref in the deploy job
//       stays unsafe. Deploy only the pinned `verified` pointer/artifact; OR
//   (c) that job selects its commit BY NAME instead of taking it from an
//       upstream job's output: a checkout `ref:` or `--ref` flag naming a
//       branch (a literal name, or an expression whose last part is `ref`,
//       `ref_name`, `head_ref`, `base_ref`, `branch` or `head_branch`), or a
//       `git fetch`/`pull`/`checkout`/`switch`/`reset`/`merge`/`rebase`/
//       `rev-parse` of a name in a run step. A name looked up again can have
//       moved since the gate approved it, so every job of a promotion must use
//       the commit passed from job to job (`${{ needs.<job>.outputs.<sha> }}`,
//       a GitLab dotenv variable). A git command is recognized however git is
//       invoked or spelled (global options, `command git`, `"git"`, inside
//       `$( … )`). Not a name: an upstream output, a shell variable, a commit
//       hash, the local HEAD, and FETCH_HEAD after fetching one of those in
//       the same repository; FETCH_HEAD of unknown origin, HEAD on a remote,
//       and an ancestor (`HEAD~1`, `verified^`) are names. Only a command the
//       shell runs (not text in a quoted string or heredoc, not an argument
//       such as `echo git …`), in a repository its own text establishes, can
//       exempt anything. A `git fetch` of a ref the same job pushes to (the
//       rendered-state ref it writes) is exempt when the push publishes — not
//       a dry run or deletion — from the same repository to the same remote,
//       in a job that does not move where its commands run (`cd`,
//       `working-directory:`, `GIT_DIR`, a repointed remote); selecting that
//       ref is not.
//       The `verified` pointer by name is allowed only in a job with no
//       upstream job (no `needs:`, or `needs: []`; in GitLab, a job in a later
//       stage than another job has one unless it says `needs: []`), and
//       resolved there once:
//       the first job of a promotion resolves it, and every later job takes
//       that result. Ref names keep their case.
//       A selection that (b) already reports is not reported again.
// Detection runs against a COMMENT-STRIPPED view, so a `#` comment can't fake a
// gate; a `#` inside a quoted string does not start a comment. See README for
// the exact heuristic and limits.
//
// Native Bun/TypeScript. Conventions (mirror ../pr-target-safety): exit 0 pass,
// 1 an unsafe workflow (per-file report), 2 a usage error; inputs via file args
// or WORKFLOWS_DIR so the self-test drives it with fixtures. A missing workflows
// dir (ENOENT) passes (safe to wire early); an unreadable one, or a path that is
// not a directory, fails closed.
//
// Usage:
//   check-promote-safety.ts                       # scan .github/workflows
//   check-promote-safety.ts path/to/deploy.yml    # explicit files
//   WORKFLOWS_DIR=path check-promote-safety.ts
import { readFileSync, readdirSync, lstatSync, statSync } from "node:fs";
type Job = {
  name: string;
  indent: number;
  deploy: boolean;
  prod: boolean;
  environment: boolean;
  manual: boolean;
  push: boolean;
  mutable: boolean;
  needs: boolean;
  emptyNeeds: boolean;
  stage: string;
  reads: Read[];
  pushed: Set<string>;
  fetched: Map<string, string>;
  elsewhere: boolean;
  heredoc: string | undefined;
};
export type Finding = { job: string; mode: "a" | "b" | "c"; name?: string };
// How a name is read: `fetch` resolves it on the remote without moving the
// job's commit, `remote` resolves it on the remote and selects it (a checkout
// `ref:`, `--ref`, `git pull`), `local` selects the local name. `from` is the
// repository and remote a fetch or pull reads, `repo` the repository a local
// read selects in; either is absent when the command does not establish it.
type Read = {
  name: string;
  how: "fetch" | "remote" | "local";
  from?: string | undefined;
  repo?: string | undefined;
};
// What one command does: the names it reads, the refs it publishes, and what
// it leaves in FETCH_HEAD — per repository, the name fetched ("" for a commit
// fetched by hash or variable, undefined when unknown), or `forget` when it may
// have changed FETCH_HEAD anywhere.
type Effect = {
  read: Read[];
  write: string[];
  fetchHead?: { repo: string; name: string | undefined } | "forget";
};
const mutableRef =
  /(^|[^a-z])ref['"]?\s*:\s*['"]?(refs\/heads\/)?(main|master|develop|trunk|head)([^a-z]|$)|--ref[\s=]+['"]?(refs\/heads\/)?(main|master|develop|trunk|head)([^a-z]|$)|github\.ref(_name)?([^a-z]|$)|[:@]latest([^a-z]|$)/;
// An expression whose last part names a branch rather than a commit.
const branchExpression =
  /^(?:.*\.)?(ref|ref_name|head_ref|base_ref|head_branch|branch)$/i;
// One token per `${{ … }}` expression: an upstream job's output becomes
// `$output`, an expression naming a branch `@<expression>`, anything else
// `$expr` (its value cannot be read from the text).
const tokenize = (s: string) =>
  s.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, e: string) =>
    /^needs\.[\w-]+\.outputs\.[\w-]+$/i.test(e)
      ? "$output"
      : branchExpression.test(e)
        ? `@${e}`
        : "$expr",
  );
// A ref as git names it, reduced to the branch or tag name it selects: a
// peeling suffix (`^{commit}`, `^0`) selects the same commit. An ancestry
// suffix (`~2`, `^`, `^2`) selects another commit and is kept. Case is kept:
// `Release` and `release` are different refs.
const refName = (t: string) =>
  t
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/^\+/, "")
    .replace(/^refs\/(heads|tags)\//, "")
    .replace(/^(refs\/remotes\/)?origin\//, "")
    .replace(/(\^\{[^}]*\}|\^0)+$/, "");
const fetchHead = (name: string) => /^fetch_head$/i.test(name);
// True when a selection does not look a commit up by name: a variable or an
// upstream output, a commit hash, a wildcard refspec that fetches everything
// rather than selecting one ref, or the commit already checked out. `HEAD` on
// a remote is that remote's default branch, a name; an ancestor of any commit
// (`HEAD~1`, `$SHA^`) is a commit nothing approved, read as a name.
const notByName = (name: string, how: Read["how"]) =>
  !/[~^]/.test(name) &&
  (name === "" ||
    name.includes("*") ||
    /^[$.-]/.test(name) ||
    /^[0-9a-f]{7,40}$/i.test(name) ||
    (how === "local" && /^head$/i.test(name)));
// Options whose value is the next word, per git verb: `-m` is a message in
// `merge` but a boolean in `checkout` and `switch`, where the next word is the
// branch.
const remoteOptions =
  "--depth --deepen --shallow-since --shallow-exclude -o --push-option --upload-pack --receive-pack -j --jobs";
const strategyOptions = "-s --strategy -X --strategy-option";
const valueOptions: Record<string, Set<string>> = Object.fromEntries(
  Object.entries({
    fetch: remoteOptions,
    pull: `${remoteOptions} ${strategyOptions}`,
    push: remoteOptions,
    checkout: "-b -B --orphan",
    switch: "-c -C --create --force-create --orphan",
    merge: `-m -F --file ${strategyOptions}`,
    rebase: `-x --exec ${strategyOptions}`,
    reset: "",
    "rev-parse": "",
  }).map(([verb, options]) => [verb, new Set(options.split(" "))]),
);
// Git's own options before the verb that take the next word as their value
// (unless written `--option=value`). Of these only `-C` keeps the repository
// known; the others can select another repository or remote.
const globalValueOptions = new Set(
  "-c -C --git-dir --work-tree --namespace --super-prefix --config-env".split(
    " ",
  ),
);
// The index just past the quoted string that starts at `i`; the end of the
// text when it does not close.
function quoteEnd(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote)
    j += quote === '"' && text[j] === "\\" ? 2 : 1;
  return Math.min(j + 1, text.length);
}
// The index just past the `)` that closes the `(` at `open`, skipping quoted
// text; the end of the text when it does not close.
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') i = quoteEnd(text, i) - 1;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return text.length;
}
// The index just past the part of a word that starts at `i`: a quoted string,
// a `$( … )` substitution, or one character.
function partEnd(text: string, i: number): number {
  const c = text[i];
  if (c === "'" || c === '"') return quoteEnd(text, i);
  if (c === "$" && text[i + 1] === "(") return closing(text, i + 1);
  return i + 1;
}
// The shell words of one command, from `start` to the first unquoted `;`, `&`,
// `|`, `)`, backtick or the end of the line. A quoted string stays one word,
// quotes included, and so does a `$( … )` substitution, whatever it contains:
// a git command inside one is read where it stands. A lone `\` is a line
// continuation, not a word.
function words(text: string, start: number): string[] {
  const out: string[] = [];
  let word = "";
  const flush = () => {
    if (word && word !== "\\") out.push(word);
    word = "";
  };
  for (let i = start; i < text.length && !/[;&|)`]/.test(text[i] ?? ""); ) {
    if (/\s/.test(text[i] ?? "")) {
      flush();
      i++;
    } else {
      const end = partEnd(text, i);
      word += text.slice(i, end);
      i = end;
    }
  }
  flush();
  return out;
}
// `runs` is true only for a command at a command position, outside quoted
// text and heredoc bodies (whether the shell reaches it, as after
// `false &&`, is not modelled); `repo` is the repository it acts on,
// undefined when its text does not establish one.
type GitCommand = {
  verb: string;
  repo: string | undefined;
  words: string[];
  runs: boolean;
  at: number;
};
// Git's own options before the verb: where the verb is, and the repository
// `-C` selects (`.` without one). Any other option (`--git-dir`,
// `--work-tree`), and a `-c`/`--config-env` setting that can redirect it
// (`remote.*`, `url.*`, `include*`, `core.*`), may point the command at another
// repository or remote, so its repository is unknown. `--no-pager` and other
// settings (`-c user.name=…`) leave it as it is.
function globalOptions(w: string[]): {
  verb: number;
  repo: string | undefined;
} {
  let repo: string | undefined = ".",
    i = 0;
  for (; (w[i] ?? "").startsWith("-"); i++) {
    const [option = "", inline] = (w[i] ?? "").split(/=(.*)/s);
    if (option === "--no-pager" || option === "-P") continue;
    const value = (
      inline ?? (globalValueOptions.has(option) ? (w[++i] ?? "") : "")
    ).replace(/^['"]+|['"]+$|\/+$/g, "");
    repo = afterOption(
      repo,
      option,
      inline === undefined || option === "--config-env" ? value : undefined,
    );
  }
  return { verb: i, repo };
}
// The repository after one global option; `value` is undefined when the
// option was written `--option=value`, which `-C` does not accept.
function afterOption(
  repo: string | undefined,
  option: string,
  value: string | undefined,
): string | undefined {
  if (option === "-c" || option === "--config-env")
    return /^(remote|url|include|includeif|core)\./i.test(value ?? "")
      ? undefined
      : repo;
  if (option !== "-C" || value === undefined || repo === undefined)
    return undefined;
  if (value === "." || value === "") return repo;
  return repo === "." ? value : `${repo}/${value}`;
}
// The index just past the shell word that starts at `i`.
function wordEnd(text: string, i: number): number {
  let j = i;
  while (j < text.length && !/[\s;&|)`]/.test(text[j] ?? ""))
    j = partEnd(text, j);
  return j;
}
// A word as the shell reads it once quotes and escapes are removed: `"git"`,
// `'g'it` and `g\it` are all `git`.
const unescaped = (w: string) => w.replace(/\\(.)/g, "$1").replace(/['"]/g, "");
// The text before a word the shell runs as a command: the start of the line
// (after a YAML key or list marker), or an operator that starts a command,
// then optionally `!`, variable assignments, `command`/`exec`, and a
// directory path to the program. `then`/`do`/`else` and `{` match wherever
// they stand, not only where the shell reads them as keywords.
const commandPosition =
  /(?:^\s*(?:-\s+)?(?:[\w.-]+\s*:\s+)?|[;&|({`]\s*|\b(?:then|do|else)\s+)(?:!\s+)?(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:command|exec)\s+)?(?:\S*\/)?$/;
// Every git command on a line, however git is spelled or invoked (`"git"`,
// `command git`, a path to git, inside `$( … )`) and whatever global options
// precede the verb. A command inside a quoted string, a heredoc body
// (`literal`), or after a word that is not a command (`echo git push …`) is
// still read, which errs toward flagging, but does not run.
function gitCommands(line: string, literal: boolean): GitCommand[] {
  const found: GitCommand[] = [],
    inside = quoted(line);
  for (const m of line.matchAll(/(?<=^|[\s;&|(`{"'\/])[^\s;&|()`{}]/g)) {
    const at = m.index ?? 0,
      end = wordEnd(line, at);
    if (unescaped(line.slice(at, end)) !== "git") continue;
    const w = words(line, end),
      { verb, repo } = globalOptions(w);
    if ((w[verb] ?? "") in valueOptions)
      found.push({
        verb: w[verb] ?? "",
        repo,
        words: w.slice(verb + 1),
        runs:
          !literal && !inside[at] && commandPosition.test(line.slice(0, at)),
        at,
      });
  }
  return found;
}
// A git command's options and its arguments that are not options or option
// values. A quoted word containing a space (a message) is never a ref. `--`
// ends the options: fetch, pull and push still take a remote and refspecs
// after it, every other verb takes paths.
function positional(verb: string, tokens: string[]) {
  const args: string[] = [],
    flags: string[] = [],
    options = valueOptions[verb] ?? new Set<string>();
  let operands = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    if (!operands && t === "--") {
      if (!["fetch", "pull", "push"].includes(verb)) break;
      operands = true;
    } else if (!operands && options.has(t)) i++;
    else if (!operands && t.startsWith("-")) flags.push(t);
    else if (!/\s/.test(t)) args.push(t);
  }
  return { args, flags };
}
// A push that publishes what it names: not a dry run (`-n`), not a deletion
// (`-d`, or a refspec with an empty source), not a mirror.
const publishes = (flags: string[]) =>
  !flags.some(
    (f) =>
      /^--(dry-run|delete|mirror)$/.test(f) ||
      (/^-[a-zA-Z]+$/.test(f) && /[nd]/.test(f)),
  );
// What one git command does. Fetch, pull and push take a remote first, then
// refspecs (`<source>:<destination>`); a bare `git pull` reads the branch's
// upstream by name, a fetch with no refspec the remote's default refspec. A
// write is keyed by repository, remote and ref, and counts only for a push
// that runs in a known repository. Only a fetch or pull that runs in a known
// repository records what FETCH_HEAD holds there: by name when any refspec
// names a ref, unknown for a wildcard or the default refspec. Any other one
// may have changed it.
function gitCommand(c: GitCommand): Effect {
  const { args, flags } = positional(c.verb, c.words),
    from = c.repo === undefined ? undefined : `${c.repo} ${args[0] ?? ""}`;
  if (c.verb === "push")
    return { read: [], write: pushWrites(c, flags, from, args.slice(1)) };
  if (c.verb === "fetch" || c.verb === "pull")
    return fetchEffect(c, from, args.slice(1));
  return {
    read: args.map((a) => ({ name: refName(a), how: "local", repo: c.repo })),
    write: [],
  };
}
// The refs a push publishes, keyed by repository, remote and ref.
function pushWrites(
  c: GitCommand,
  flags: string[],
  from: string | undefined,
  specs: string[],
): string[] {
  if (!c.runs || c.repo === undefined || !publishes(flags)) return [];
  return specs
    .map((a) => a.replace(/^['"]+|['"]+$/g, "").replace(/^\+/, ""))
    .filter((a) => !a.startsWith(":"))
    .map((a) => `${from} ${refName(a.split(":").pop() ?? "")}`);
}
// What a fetch or pull reads, and what it leaves in FETCH_HEAD.
function fetchEffect(
  c: GitCommand,
  from: string | undefined,
  specs: string[],
): Effect {
  const how = c.verb === "fetch" ? ("fetch" as const) : ("remote" as const),
    read =
      c.verb === "pull" && !specs.length
        ? [{ name: "(upstream)", how, from }]
        : (specs.length ? specs : ["*"]).map((a) => ({
            name: refName(a.split(":")[0] ?? ""),
            how,
            from,
          }));
  if (!c.runs || c.repo === undefined)
    return { read, write: [], fetchHead: "forget" };
  const named = read.find((r) => !notByName(r.name, r.how))?.name,
    wildcard = read.some((r) => r.name.includes("*"));
  return {
    read,
    write: [],
    fetchHead: { repo: c.repo, name: wildcard ? undefined : (named ?? "") },
  };
}
// The positions of a line that sit inside a shell or YAML quoted string. A
// quote left open runs to the end of the line.
function quoted(line: string): boolean[] {
  const inside: boolean[] = [];
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    inside[i] = quote !== "";
    if (quote === '"' && c === "\\") inside[++i] = true;
    else if (quote && c === quote) quote = "";
    else if (!quote && (c === '"' || c === "'")) {
      quote = c;
      inside[i] = true;
    }
  }
  return inside;
}
// A line without its `#` comment: a `#` at the start or after whitespace,
// outside any quoted string, begins one.
function stripComment(line: string): string {
  const inside = quoted(line);
  for (let i = 0; i < line.length; i++)
    if (
      line[i] === "#" &&
      !inside[i] &&
      (i === 0 || /\s/.test(line[i - 1] ?? ""))
    )
      return line.slice(0, i).trimEnd();
  return line;
}
// The shell text of a line whose value is a YAML quoted scalar closing on the
// same line (`run: 'git …'`, `- "git …"`): YAML removes those quotes before
// the shell sees the command, so they are not shell quoting.
function shellText(line: string): string {
  const m = line.match(
    /^(\s*(?:-\s+)?(?:[\w.-]+\s*:\s+)?)('(?:[^']|'')*'|"(?:[^"\\]|\\.)*")\s*$/,
  );
  if (!m) return line;
  const scalar = m[2] ?? "",
    body = scalar.slice(1, -1);
  return (
    (m[1] ?? "") +
    (scalar.startsWith("'")
      ? body.replace(/''/g, "'")
      : body.replace(/\\(.)/g, "$1"))
  );
}
// The terminator of a heredoc a line opens (`<<EOF`, `<<-'EOF'`), outside
// any quoted string; its body is text, not commands.
function heredocStart(line: string): string | undefined {
  const inside = quoted(line);
  for (const m of line.matchAll(/(?<!<)<<-?(?!<)\s*(['"]?)([\w-]+)\1/g))
    if (!inside[m.index ?? 0]) return m[2];
  return undefined;
}
// What each command on a line does, in the order they stand: its git
// commands, and a checkout `ref:` or a `--ref` flag, which selects by name and
// may have changed FETCH_HEAD.
function selections(raw: string, literal: boolean): Effect[] {
  const line = tokenize(raw),
    effects = gitCommands(line, literal).map((c) => ({
      ...gitCommand(c),
      at: c.at,
    }));
  for (const m of line.matchAll(
    /(?:^|[\s{,])["']?ref["']?\s*:\s*([^,}\s]+)|--ref[\s=]+(\S+)/gi,
  ))
    effects.push({
      read: [{ name: refName(m[1] ?? m[2] ?? ""), how: "remote" }],
      write: [],
      fetchHead: "forget",
      at: m.index ?? 0,
    });
  return effects.sort((a, b) => a.at - b.at);
}
// A mapping key, bare or quoted: `deploy:`, `"deploy-prod":`, `'on':`.
const keyOf = (line: string) => {
  const m = line.match(/^\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+))\s*:/);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : undefined;
};
const q = `["']?`;
// A real `when: manual` property: its own `when` key (block entry, list item or
// flow mapping), never text inside a command string or block scalar.
const manualEntry = new RegExp(
  `^\\s*(-\\s+)?${q}when${q}\\s*:\\s*${q}manual${q}\\s*$`,
);
const unquote = (s: string) => {
  const t = s.trim();
  return /^(".*"|'.*')$/.test(t) ? t.slice(1, -1).trim() : t;
};
// True when a single-line flow mapping (`{ a: b, when: manual }`, optionally a
// list item) has a top-level `when` entry whose value is `manual`. Entries
// split only at commas of the outer mapping: commas inside quoted strings
// (honoring `\"` escapes and the `''` escape) or nested `{}`/`[]` do not split.
// A mapping that does not close on the line, or has an unterminated string or
// unbalanced nesting, cannot be read confidently and is not treated as a gate.
function flowHasManual(line: string): boolean {
  const m = line.match(/^\s*(?:-\s+)?\{/);
  if (!m) return false;
  const entries: string[] = [];
  let quote = "",
    depth = 0,
    closed = false,
    start = m[0].length;
  for (let i = start; i < line.length && !closed; i++) {
    const c = line[i];
    if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = "";
    } else if (quote === "'") {
      if (c === "'" && line[i + 1] === "'") i++;
      else if (c === "'") quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "]" || c === "}") && depth > 0) depth--;
    else if (c === "}" || (c === "," && depth === 0)) {
      entries.push(line.slice(start, i));
      start = i + 1;
      closed = c === "}";
    }
  }
  if (!closed) return false;
  return entries.some((entry) => {
    const kv = entry.match(/^\s*("[^"]*"|'[^']*'|[^\s:'"]+)\s*:\s*(.*)$/);
    return (
      kv !== null &&
      unquote(kv[1] ?? "") === "when" &&
      unquote(kv[2] ?? "") === "manual"
    );
  });
}
const manualProperty = (s: string) => manualEntry.test(s) || flowHasManual(s);
const gitlabPush = (s: string) =>
  new RegExp(
    `ci_pipeline_source\\s*==\\s*['"]?push|^\\s*${q}only${q}\\s*:.*push|^\\s*-\\s*${q}pushes([^a-z]|$)`,
  ).test(s);
export function findings(content: string): Finding[] {
  const lines = content.split(/\r?\n/).map(stripComment),
    jobsKey = new RegExp(`^\\s*${q}jobs${q}\\s*:\\s*$`),
    gha = lines.some((l) => jobsKey.test(l));
  const reserved = new Set(
    "stages variables default workflow include image services cache before_script after_script pages".split(
      " ",
    ),
  );
  const jobs = new Map<string, Job>();
  let saw = false,
    jobsIndent = -1,
    level = -1,
    cur: Job | undefined,
    push = false,
    scalarIndent = -1;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const lc = raw.toLowerCase(),
      ind = raw.length - raw.trimStart().length;
    if (gha && jobsKey.test(raw)) {
      saw = true;
      jobsIndent = ind;
      level = -1;
      cur = undefined;
      continue;
    }
    let header = false;
    const key = keyOf(raw);
    const inScalar = scalarIndent >= 0 && ind > scalarIndent;
    if (!inScalar)
      scalarIndent = /(^|[:-])\s*[|>](?:[+-][0-9]?|[0-9][+-]?)?\s*$/.test(raw)
        ? ind
        : -1;
    if (gha && saw) {
      if (ind <= jobsIndent) cur = undefined;
      else {
        if (level === -1 && key !== undefined) level = ind;
        if (level >= 0 && ind === level && key !== undefined) header = true;
      }
    } else if (!gha && ind === 0 && key !== undefined) {
      if (reserved.has(key ?? "")) {
        cur = undefined;
        continue;
      }
      header = true;
    }
    if (header) {
      const name = key ?? "";
      cur = jobs.get(name) ?? newJob(name);
      jobs.set(name, cur);
    }
    if (!cur) {
      if (
        new RegExp(
          `^\\s*${q}on${q}\\s*:\\s*${q}push(["'\\s]|$)|^\\s*${q}on${q}\\s*:\\s*\\[[^\\]]*push|^\\s*${q}on${q}\\s*:\\s*\\{.*push|^\\s*-\\s*${q}push${q}\\s*$|^\\s*${q}push${q}\\s*:`,
        ).test(raw) ||
        gitlabPush(lc)
      )
        push = true;
      continue;
    }
    if (!header && cur.indent === -1) cur.indent = ind;
    observe(cur, raw, ind, !gha && !inScalar);
  }
  stageUpstream([...jobs.values()], lines, gha);
  return [...jobs.values()].flatMap((j) => jobFindings(j, push));
}
// GitLab's stage order: the top-level `stages:` list (flow or block form), or
// GitLab's default, between `.pre` and `.post`.
function stageOrder(lines: string[]): string[] {
  const at = lines.findIndex((l) => /^\S/.test(l) && keyOf(l) === "stages");
  const flow = lines[at]?.match(/:\s*\[(.*)\]\s*$/),
    block: string[] = [];
  for (const l of at >= 0 && !flow ? lines.slice(at + 1) : []) {
    if (/^\S/.test(l)) break;
    const item = l.match(/^\s+-\s*(.+?)\s*$/);
    if (item) block.push(unquote(item[1] ?? ""));
  }
  const stages = flow
    ? (flow[1] ?? "").split(",").map(unquote)
    : block.length
      ? block
      : ["build", "test", "deploy"];
  return [".pre", ...stages, ".post"];
}
// In GitLab a job without `needs:` waits for every job in an earlier stage,
// so those are its upstream jobs; `needs: []` opts out. When either job's
// stage is missing from the order, the order cannot be read and the other job
// counts as upstream. Hidden jobs (`.name`) never run. GitHub Actions has no
// stages.
function stageUpstream(jobs: Job[], lines: string[], gha: boolean) {
  if (gha) return;
  const order = stageOrder(lines);
  const runnable = jobs.filter((j) => !j.name.startsWith("."));
  const earlier = (o: Job, j: Job) => {
    const [a, b] = [order.indexOf(o.stage), order.indexOf(j.stage)];
    return a < 0 || b < 0 || a < b;
  };
  for (const j of runnable)
    j.needs ||= !j.emptyNeeds && runnable.some((o) => o !== j && earlier(o, j));
}
const newJob = (name: string): Job => ({
  name,
  indent: -1,
  deploy: false,
  prod: false,
  environment: false,
  manual: false,
  push: false,
  mutable: false,
  needs: false,
  emptyNeeds: false,
  stage: "test",
  reads: [],
  pushed: new Set(),
  fetched: new Map(),
  elsewhere: false,
  heredoc: undefined,
});
// A line after which a command's text no longer tells where it runs: a change
// of directory (`cd`, `pushd`, a step's `working-directory:`), git's
// repository variables, or a remote being repointed.
const movesElsewhere =
  /(^|[\s;&|(`])(cd|pushd|popd)(\s|$)|working-directory\s*:|\bGIT_(DIR|WORK_TREE|COMMON_DIR|NAMESPACE|CONFIG\w*)\b|\bremote\s+(add|set-url|rename)\b|\bremote\.\S*(url|insteadof)/i;
// Record what one line of a job's body says about the job. `manualAllowed` is
// false where a `when: manual` cannot be a property: in a GitHub workflow, or
// inside a block scalar.
function observe(job: Job, raw: string, ind: number, manualAllowed: boolean) {
  const lc = raw.toLowerCase(),
    jobKey = ind === job.indent ? keyOf(raw) : undefined;
  job.deploy ||= /deploy/.test(lc);
  job.prod ||= /(^|[^a-z])(prod|production)([^a-z]|$)/.test(lc);
  job.environment ||= jobKey === "environment";
  job.needs ||= jobKey === "needs" && !/:\s*\[\s*\]\s*$/.test(raw);
  job.emptyNeeds ||= jobKey === "needs" && /:\s*\[\s*\]\s*$/.test(raw);
  if (jobKey === "stage") job.stage = unquote(raw.slice(raw.indexOf(":") + 1));
  job.manual ||= manualAllowed && manualProperty(lc);
  job.push ||= gitlabPush(lc);
  const text = shellText(raw),
    literal = job.heredoc !== undefined;
  if (literal) {
    if (text.trim() === job.heredoc) job.heredoc = undefined;
  } else job.heredoc = heredocStart(text);
  job.elsewhere ||= !literal && movesElsewhere.test(text);
  if (mutableRef.test(lc)) {
    job.mutable = true;
    return;
  }
  for (const effect of selections(text, literal)) apply(job, effect);
}
// Apply one command's effect to the job, in order.
function apply(job: Job, effect: Effect) {
  for (const r of effect.read) record(job, r);
  for (const name of effect.write) job.pushed.add(name);
  const held = effect.fetchHead;
  if (held === "forget") job.fetched.clear();
  else if (held?.name === undefined) {
    if (held) job.fetched.delete(held.repo);
  } else job.fetched.set(held.repo, held.name);
}
// Record one read in order. FETCH_HEAD in a repository is what the job last
// fetched there: the name it fetched, or nothing by name when that was a
// commit or a variable. Where that is not known, FETCH_HEAD counts as a name.
function record(job: Job, r: Read) {
  if (fetchHead(r.name)) {
    const name =
      (r.repo === undefined ? undefined : job.fetched.get(r.repo)) ??
      "FETCH_HEAD";
    if (!notByName(name, "remote")) job.reads.push({ name, how: r.how });
    return;
  }
  if (!notByName(r.name, r.how)) job.reads.push(r);
}
// A production-deploy job's findings; any other job has none. `push` is
// whether the workflow itself fires on push.
function jobFindings(j: Job, push: boolean): Finding[] {
  if (!j.deploy || !j.prod) return [];
  const result: Finding[] = [];
  if ((push || j.push) && !j.environment && !j.manual)
    result.push({ job: j.name, mode: "a" });
  if (j.mutable) result.push({ job: j.name, mode: "b" });
  // The verified pointer may be resolved on the remote once, and only by a
  // job with no upstream job, whatever else the job does with it. A ref the
  // job pushes to, in the same repository and on the same remote, may be
  // fetched to commit to it, unless the job moves where its commands run;
  // selecting it would ship it.
  let resolved = 0;
  const read = j.reads.find((r) => {
    if (r.name === "verified") {
      if (r.how !== "local") resolved++;
      return j.needs || resolved > 1;
    }
    return !(
      r.how === "fetch" &&
      !j.elsewhere &&
      j.pushed.has(`${r.from} ${r.name}`)
    );
  });
  if (read !== undefined)
    result.push({ job: j.name, mode: "c", name: read.name });
  return result;
}
// Genuine absence (ENOENT) passes; anything else (permissions, a regular file
// where the directory should be, a dangling link) is an error, not a pass.
function directoryExists(dir: string): boolean {
  try {
    if (statSync(dir).isDirectory()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      lstatSync(dir);
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw inner;
    }
    throw new Error(`workflows path is a dangling link: ${dir}`);
  }
  throw new Error(`workflows path is not a directory: ${dir}`);
}
export function main(args = process.argv.slice(2), env = process.env): number {
  const dir = env.WORKFLOWS_DIR || ".github/workflows";
  let files = args;
  if (!files.length) {
    if (!directoryExists(dir)) {
      console.log(`OK — ${dir} does not exist (no workflows to check)`);
      return 0;
    }
    files = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => `${dir}/${f}`);
  }
  let bad = false;
  for (const f of files) {
    if (!statSync(f).isFile()) throw new Error(`not a file: ${f}`);
    for (const finding of findings(readFileSync(f, "utf8"))) {
      bad = true;
      console.log(`UNSAFE ${f}`);
      console.log(explain[finding.mode](finding.job, finding.name ?? ""));
    }
  }
  console.log(
    bad
      ? "Promote-safety lint FAILED — an unsafe production-deploy path was found."
      : "OK — no unsafe production-deploy workflows",
  );
  return bad ? 1 : 0;
}
// What each finding means and how to fix it, by mode.
const explain: Record<Finding["mode"], (j: string, name: string) => string> = {
  a: (j) =>
    `  (a) job '${j}' deploys to production and fires automatically on push with\n      nothing gating the push run (no environment: protection, no when: manual).\n      A workflow_dispatch trigger does not count. Fix: gate this job behind a\n      protected environment (or trigger the workflow only manually).\n`,
  b: (j) =>
    `  (b) job '${j}' selects a mutable ref (a moving branch / HEAD / :latest).\n      A production deploy must ship ONLY the verified pointer/artifact; a\n      mutable ref means what reaches prod is whatever the branch is, not what\n      passed verification. A verified reference elsewhere in the job does not\n      clear this (the lint cannot prove the deploy uses it).\n      Fix: remove the mutable ref; deploy refs/tags/verified (or the verified artifact).\n`,
  c: (j, name) =>
    `  (c) job '${j}' selects its commit by name ('${name}') instead of\n      taking it from an upstream job's output. A name looked up again can have\n      moved since the gate approved it, so this job may ship a commit nothing\n      verified. Fix: have the gating job output the commit it approved and use\n      \${{ needs.<job>.outputs.<sha> }} (GitLab: a dotenv variable). Only a job\n      with no upstream job (no needs:, or needs: []) may resolve the verified\n      pointer by name, and only once.\n`,
};
if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}
