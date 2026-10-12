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
  bun tools/plugin/setup.ts            # install or update
  bun tools/plugin/setup.ts --check    # exit 1 when missing
  bun tools/plugin/setup.ts --source /path/to/jig   # from a local checkout
  bun tools/plugin/setup.ts --claude   # only Claude Code (or --codex)
  ```

  `--source`, or the `JIG_MARKETPLACE` environment variable, replaces
  the default source (this repository's HTTPS address); either is refused
  when the marketplace is already registered from somewhere else, and the
  message gives the command that removes it.

- [plugin.test.ts](plugin.test.ts) pins both plugin manifests and both
  marketplaces to one name and version, checks that both manifests name the
  drive loop's skills and every shipped agent, checks every skill's and
  agent's name and paths, keeps the vendored YAML parser identical to the
  pinned package, and runs the skills' scripts (the review skill, the
  procedure skills, `decide` and `explain`) from a copy outside this
  repository, with no `node_modules` above it, against a scratch consumer
  repository, the way a plugin cache holds them.
