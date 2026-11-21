// Checks that the layout engine still gives exactly the same results as in a
// git commit, for changes that must not change behavior (refactoring, renames,
// reformatting):
//
//   node tools/compare-engine.js [REVISION]
//
// Runs the committed spreadLayout.js (REVISION, default HEAD) and the one in
// the working tree over the same fixed set of about 3900 calls: every
// algorithm with many settings, 0 to 17 windows on four monitors, plus score(),
// the cache and the error messages. Every number must be bit-identical.
// Prints the first difference and exits with 1 if there is one.
"use strict";
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const FILE = "extension/window-spread@soren-kragh/spreadLayout.js";

function fail(msg) { console.error("compare-engine: " + msg); process.exit(2); }
// The engine from its source text, as the lab's worker threads build it.
function engine(src) { return new Function(src + "\n;return createSpreadLayout;")()(); }

const rev = process.argv[2] || "HEAD";
const show = spawnSync("git", ["show", rev + ":" + FILE], { cwd: ROOT, encoding: "utf8" });
if (show.status !== 0) fail("can't read " + FILE + " at " + rev + ": " + show.stderr.trim());
const OLD = engine(show.stdout);
const NEW = engine(fs.readFileSync(path.join(ROOT, FILE), "utf8"));

// Exact text of a result: numbers as JSON (shortest exact form), but -0, NaN
// and the infinities spelled out, since JSON would hide them.
function exact(v) {
  return JSON.stringify(v, (k, x) => typeof x !== "number" || (Number.isFinite(x) && !Object.is(x, -0))
    ? x : "#" + (Object.is(x, -0) ? "-0" : String(x)));
}
function run(SL, f) {
  try { return exact(f(SL)); } catch (e) { return "throws: " + (e && e.message); }
}

// The calls: f(SL) gets an engine and returns what to compare.
const calls = [];
const add = (label, f) => calls.push({ label, f });

add("DEFAULTS", SL => SL.DEFAULTS);
add("ALGORITHMS", SL => SL.ALGORITHMS);
for (const a of NEW.ALGORITHMS) add("settings " + a, SL => SL.settings(a));

const rnd = NEW.random(2024);
const MON = [
  { x: 0, y: 0, w: 1920, h: 1080 }, { x: 1920, y: 0, w: 2560, h: 1440 },
  { x: 0, y: 1080, w: 1080, h: 1920 }, { x: -1280, y: 200, w: 1280, h: 1024 },
];
function desktop(n, mon) {
  const ws = [];
  for (let i = 0; i < n; i++) {
    const w = Math.round(200 + rnd() * mon.w * 0.8), h = Math.round(150 + rnd() * mon.h * 0.8);
    const x = mon.x + Math.round(rnd() * (mon.w - w * 0.5));
    const y = mon.y + Math.round(rnd() * (mon.h - h * 0.5));
    ws.push({ id: 100 + i * 7, x, y, w, h });
  }
  return ws;
}
const COMMON = [
  {}, { centered: true }, { fill: true }, { fidelity: 0 }, { fidelity: 1, maxScale: 1 },
  { relationsMethod: "order" }, { neighborFocus: 1, wRelations: 3 },
  { extraGapX: 30, extraGapY: 70, gap: 10, margin: 20 }, { gap: 200, margin: 200 },
  { wSize: 0, wPlace: 5 },
];
const OWN = {
  optimizer: [{ steps: 300 }, { steps: 300, startFrom: "push" }, { steps: 300, startFrom: "rows" },
    { steps: 300, startFrom: "grid" }, { steps: 300, startFrom: "none", dropWeakStarts: false },
    { steps: 200, starts: 7, seed: 3 }, { steps: 300, polish: false }],
  push: [{}, { matchShape: 0, strength: 1 }, { polish: false, passes: 3 }],
  rows: [{}, { rows: 2 }, { rows: 50 }],
  grid: [{}],
};
let count = 0;
for (const n of [0, 1, 2, 3, 5, 8, 12, 17]) {
  for (const mon of MON) {
    const ws = desktop(n, mon);
    for (const a of NEW.ALGORITHMS) {
      for (const own of OWN[a]) {
        for (const common of COMMON) {
          count++;
          // all combinations up to 8 windows, a third of them above
          if (n > 8 && common !== COMMON[0] && count % 3) continue;
          const ov = Object.assign({}, common, own);
          add(`compute ${a} n=${n} monitor ${mon.x},${mon.y} ${JSON.stringify(ov)}`,
            SL => SL.compute(ws, mon, a, SL.settings(a, ov)));
        }
      }
    }
    add(`compute defaults n=${n} monitor ${mon.x},${mon.y}`, SL => SL.compute(ws, mon, "optimizer"));
  }
}
const ws5 = desktop(5, MON[0]);
add("score", SL => SL.score(SL.compute(ws5, MON[0], "push").targets, ws5, MON[0], SL.settings("push")));
add("cache", SL => {
  const c = SL.createCache();
  return [c.compute(ws5, MON[0], "rows", null, "a"),
    c.compute(ws5.slice().reverse(), MON[0], "rows", null, "a"),
    (c.forget("a"), c.compute(ws5, MON[0], "rows", {}, "a")),
    (c.clear(), c.compute(ws5, MON[0], "grid"))];
});
add("error: unknown algorithm", SL => SL.compute(ws5, MON[0], "bogus"));
add("error: no usable area", SL => SL.compute(ws5, { x: 0, y: 0, w: 10, h: 10 }, "push"));
add("error: window frame", SL => SL.compute([{ id: 1, x: 0, y: 0, w: 0, h: 5 }], MON[0], "push"));
add("error: setting", SL => SL.compute(ws5, MON[0], "push", SL.settings("push", { gap: -1 })));
const ws8 = desktop(8, MON[0]);
add("error: no room for rows", SL => SL.compute(ws8, MON[0], "rows",
  SL.settings("rows", { gap: 2000, margin: 0 })));
add("random", SL => { const r = SL.random(5); return [r(), r(), r()]; });

const t0 = Date.now();
for (const { label, f } of calls) {
  const a = run(OLD, f), b = run(NEW, f);
  if (a === b) continue;
  let i = 0;
  while (a[i] === b[i]) i++;
  console.log("DIFFERENT: " + label);
  console.log("  " + rev + ":        ..." + a.slice(Math.max(0, i - 40), i + 60));
  console.log("  working tree: ..." + b.slice(Math.max(0, i - 40), i + 60));
  process.exit(1);
}
console.log(`identical to ${rev}: ${calls.length} calls, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
