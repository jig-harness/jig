import { expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  cliTransport,
  httpTransport,
} from "../scripts/lib/tracker/linear-transport.ts";
import { linearTracker } from "../scripts/lib/tracker/linear.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";

it("keeps opaque CLI snapshots in memory and permits persistent token-backed snapshots", () => {
  const source = (transport: ReturnType<typeof cliTransport>) =>
    linearTracker({
      team: "ENG",
      states: parseTrackerConfig({}).states,
      transport,
    }).dispatchSource;
  expect(source(cliTransport())?.persistent).toBe(false);
  expect(source(httpTransport("test-token"))?.persistent).toBe(true);
});

it("shares an opaque CLI credential within a process and never across CLI sessions", () => {
  const module = join(
    import.meta.dir,
    "../scripts/lib/tracker/linear-transport.ts",
  );
  const code = `import {cliTransport,httpTransport,defaultTransport,dispatchCredential} from ${JSON.stringify(module)};
    const governor={admit(){},observe(){}};
    console.log(JSON.stringify({
      cli:dispatchCredential(cliTransport()),again:dispatchCredential(cliTransport()),
      defaultCli:dispatchCredential(defaultTransport({},governor)),
      http:dispatchCredential(httpTransport("test-token")),
      defaultHttp:dispatchCredential(defaultTransport({LINEAR_API_KEY:"test-token"},governor))
    }));`;
  const read = (): {
    cli: string;
    again: string;
    defaultCli: string;
    http: string;
    defaultHttp: string;
  } => {
    const child = Bun.spawnSync([process.execPath, "--eval", code], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    expectSpawnExit(child, 0);
    return JSON.parse(child.stdout.toString());
  };
  const first = read();
  const second = read();
  expect(first.cli).toBe(first.again);
  expect(first.defaultCli).toBe(first.cli);
  expect(second.cli).not.toBe(first.cli);
  expect(first.http).toBe(first.defaultHttp);
  expect(second.http).toBe(first.http);
  expect(JSON.stringify(first)).not.toContain("test-token");
});
