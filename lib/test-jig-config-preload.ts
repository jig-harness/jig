// Bun `[test] preload`: no test reads the configuration of the machine it
// runs on. The user layer (`~/.jig/jig.yaml`) and `JIG__*` variables would
// otherwise change what every configuration-reading test sees, differently
// on each developer's machine and in CI. A test that exercises those layers
// sets `JIG_HOME` or the variables itself. Child processes inherit this.
import { join } from "node:path";

process.env.JIG_HOME = join(import.meta.dirname, "fixtures", "no-jig-home");
for (const name of Object.keys(process.env))
  if (name.startsWith("JIG__")) delete process.env[name];
