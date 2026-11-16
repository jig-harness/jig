// Preloaded into the collecting `jig gc` by orca-head-hold.test.ts: the first
// clock read from a frame named `submit` throws.
const instant = Temporal.Now.instant;
let thrown = false;
Temporal.Now.instant = () => {
  if (!thrown && /\bat submit\b/.test(new Error("stack probe").stack ?? "")) {
    thrown = true;
    throw new Error("injected: the submit step threw");
  }
  return instant();
};
