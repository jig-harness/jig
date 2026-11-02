# Plugin tooling

Installing Jig's skills should be one command per machine, and a broken
plugin layout should fail here rather than on someone's machine. This
directory holds the tooling that makes that so. How to install, configure,
update and release the plugin is in [plugin/README.md](../../plugin/README.md).

- [setup.ts](setup.ts) installs the `jig` plugin for Claude Code and
  Codex (whichever is on `PATH`), updates it when already installed, and with
  `--check` reports what is installed. It prints each command it runs and
  changes only the tools' user-level plugin settings and caches. Each tool
  command is limited to `JIG_SETUP_TIMEOUT_SECONDS` (default 300), so a
  stalled fetch fails instead of hanging an image build. It exits 1 when the
  plugin is missing or disabled for a tool it found, or when neither tool is
  on `PATH`.

  ```sh
  bun tools/plugin/setup.ts            # install (following stable) or update
  bun tools/plugin/setup.ts --channel latest   # follow latest instead
  bun tools/plugin/setup.ts --check    # exit 1 when missing; names the channel
  bun tools/plugin/setup.ts --source /path/to/jig   # from a local checkout
  bun tools/plugin/setup.ts --claude   # only Claude Code (or --codex)
  ```

  A fresh install follows the `stable` channel (`latest` while `stable` has
  no version yet); an installed one keeps what it follows and is updated, with
  a warning when that is `main`. `--channel` adds the channel to the source as
  its ref. `--source`, or the `JIG_MARKETPLACE` environment variable, replaces
  the default source (this repository's HTTPS address). A source or channel
  other than the registered one is refused, and the message gives the command
  that removes the registration; removing it uninstalls the plugin, which the
  next run installs again. Codex keeps the ref only in its `config.toml`
  (`$CODEX_HOME`, else `~/.codex`), which setup reads.

- [artifact.ts](artifact.ts) builds the plugin as the release channels ship
  it: the two marketplace files and `plugin/`, less `__tests__/`, `AGENTS.md`
  and `CLAUDE.md`. `isShipped` is that rule; the channels build from a tag's
  objects with it, and the gates and the plugin tests from the working tree.
  `bun tools/plugin/artifact.ts <dir>` writes the working tree's build to a
  new directory, to inspect it or to copy into an image.

- [channel.ts](channel.ts) moves the release channels: `status`, `check
  <version>` (the promotion rule, read-only), and `promote`, `rollback` and
  `latest`, which write the channel's next commit and a git bundle of it for
  `.github/workflows/channels.yml` to check and push. It reads the tags and
  channels from `origin` and the gates and regression issues from GitHub
  through `gh`. Exit 3 is a refusal by the rule, naming each reason; 2 a fact
  it could not read. [channel.test.ts](channel.test.ts) runs the rule's cases
  and the whole path against a scratch origin, pushing with the workflow's own
  push script.

- [vendor-optique.ts](vendor-optique.ts) vendors Optique, the parser the
  `jig` command line is written with, into `plugin/shared/vendor/`: the
  plugin runs without `node_modules` and Optique ships no single-file build,
  so it bundles the names [optique-entry.ts](optique-entry.ts) lists from the
  pinned package with Bun's bundler, unminified, and writes the bundle, its
  declarations (the package's own types) and the package's licence. A script
  that needs another of Optique's functions adds its name to the entry and
  runs `bun tools/plugin/vendor-optique.ts`; `--check` exits 1 naming each
  vendored file that differs from a fresh build.

- [vendored.test.ts](vendored.test.ts) keeps the vendored YAML parser
  identical to the pinned js-yaml build and the vendored command-line parser
  identical to a fresh build of the pinned Optique.

- [plugin.test.ts](plugin.test.ts) checks that both manifests name the
  drive loop's skills and every shipped agent, checks every skill's and
  agent's name and paths, and runs the skills' scripts (the review skill, the
  procedure skills, `decide` and `explain`) from a copy built by
  `artifact.ts` outside this repository, with no `node_modules` above it,
  against a scratch consumer repository, the way a plugin cache holds them.
  That the manifests and marketplaces agree, and that Claude Code's validator
  passes on the build, is `scripts/check-plugin.ts`, a stage of
  `bun run gates`.
