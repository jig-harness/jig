# Plugin tooling

Installing Groundwork's skills should be one command per machine, and a broken
plugin layout should fail here rather than on someone's machine. This
directory holds the tooling that makes that so. How to install, configure,
update and release the plugin is in [plugin/README.md](../../plugin/README.md).

- [setup.ts](setup.ts) installs the `groundwork` plugin for Claude Code and
  Codex (whichever is on `PATH`), updates it when already installed, and with
  `--check` reports what is installed. It prints each command it runs and
  changes only the tools' user-level plugin settings and caches. Each tool
  command is limited to `GROUNDWORK_SETUP_TIMEOUT_SECONDS` (default 300), so a
  stalled fetch fails instead of hanging an image build.

  ```sh
  bun tools/plugin/setup.ts            # install or update
  bun tools/plugin/setup.ts --check    # exit 1 when missing
  bun tools/plugin/setup.ts --source /path/to/groundwork   # from a local checkout
  ```

- [plugin.test.ts](plugin.test.ts) pins both plugin manifests and both
  marketplaces to one name and version, checks that both manifests serve the
  shipped skills and agents, checks every skill's and agent's name and paths,
  keeps the vendored YAML parser identical to the pinned package, and runs the
  review skill's scripts from a copy outside this repository against a scratch
  consumer repository, the way a plugin cache holds them.
