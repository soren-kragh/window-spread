// Tests for the layout engine (extension/window-spread@soren-kragh/spreadLayout.js).
// Run alone with: node tests/engine.test.js
const path = require('path'), fs = require('fs');
const { section, ok, note } = require('./lib/check');
const ENGINE = path.join(__dirname, '..', 'extension', 'window-spread@soren-kragh', 'spreadLayout.js');
const SL = require(ENGINE);

const MON = { x: 0, y: 0, w: 1920, h: 1080 };
// Reproducible random desktops; every third one has small windows (crowded case).
function desk(seed, n) {
  const r = SL.random(seed * 7919 + n);
  return Array.from({ length: n }, (_, i) => {
    const small = (seed + i) % 3 === 0;
    const w = small ? 260 + r() * 300 : 380 + r() * 900, h = small ? 180 + r() * 220 : 260 + r() * 560;
    return { id: i + 1, x: r() * (MON.w - w), y: r() * (MON.h - h), w, h };
  });
}
function shuffled(a, seed) {
  const b = a.slice(), r = SL.random(seed);
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = b[i]; b[i] = b[j]; b[j] = t; }
  return b;
}
const byId = T => T.slice().sort((a, b) => a.id - b.id);
const quick = (alg, ov) => SL.settings(alg, Object.assign(alg === 'anneal' ? { iterations: 4000 } : {}, ov || {}));

async function run() {
  section('Engine: API');
  ok('exposes DEFAULTS, ALGORITHMS, settings, compute, createCache, score, random',
    ['DEFAULTS', 'ALGORITHMS', 'settings', 'compute', 'createCache', 'score', 'random'].every(k => k in SL));
  ok('algorithms are anneal, natural, rows, grid', SL.ALGORITHMS.join() === 'anneal,natural,rows,grid');
  let frozen = true; try { SL.DEFAULTS.common.margin = -1; } catch (e) { /* strict mode throws */ }
  frozen = SL.DEFAULTS.common.margin !== -1;
  ok('DEFAULTS cannot be modified', frozen);
  const sa = SL.settings('anneal');
  ok('settings("anneal") includes the push-apart and rows start settings from their DEFAULTS',
    sa.pushStart.step === SL.DEFAULTS.natural.step && sa.rowsStart.rows === SL.DEFAULTS.rows.rows);
  ok('empty input gives an empty result', SL.compute([], MON, 'anneal').targets.length === 0);
  let threw = false; try { SL.compute(desk(1, 3), MON, 'bogus'); } catch (e) { threw = true; }
  ok('unknown algorithm is an error', threw);

  section('Engine: guarantees, for every algorithm (1 to 16 windows)');
  for (const alg of SL.ALGORITHMS) {
    let overlaps = 0, tightGaps = 0, outside = 0, tooBig = 0, nondet = 0, orderDep = 0, extraDep = 0, runs = 0;
    for (const n of [1, 2, 3, 5, 8, 12, 16]) for (const seed of [1, 2]) {
      const ws = desk(seed, n), S = quick(alg), A = { x: MON.x + S.margin, y: MON.y + S.margin, w: MON.w - 2 * S.margin, h: MON.h - 2 * S.margin };
      const T = SL.compute(ws, MON, alg, S).targets; runs++;
      for (const a of T) {
        if (a.x < A.x - 0.5 || a.y < A.y - 0.5 || a.x + a.w > A.x + A.w + 0.5 || a.y + a.h > A.y + A.h + 0.5) outside++;
        if (a.scale > S.maxScale + 1e-9) tooBig++;
        for (const b of T) if (a.id < b.id) {
          const gx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), gy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
          const gap = Math.max(gx, gy);
          if (gap < 0) overlaps++; else if (gap < S.spacing - 0.01) tightGaps++;
        }
      }
      if (JSON.stringify(T) !== JSON.stringify(SL.compute(ws, MON, alg, S).targets)) nondet++;
      if (JSON.stringify(byId(T)) !== JSON.stringify(byId(SL.compute(shuffled(ws, n), MON, alg, S).targets))) orderDep++;
      const decorated = ws.map((w, i) => Object.assign({ minimized: i % 2 === 0, stackIndex: n - i, focused: i === 0 }, w));
      if (JSON.stringify(T) !== JSON.stringify(SL.compute(decorated, MON, alg, S).targets)) extraDep++;
    }
    ok(alg + ': no overlaps, gaps at least the setting, inside the margin, scale within the limit',
      !overlaps && !tightGaps && !outside && !tooBig, runs + ' layouts');
    ok(alg + ': deterministic, independent of input order (stacking) and of extra fields (minimized, focus)',
      !nondet && !orderDep && !extraDep);
  }

  section('Engine: uniform scale');
  {
    let worst = 1;
    for (const alg of ['anneal', 'natural', 'rows']) for (const n of [4, 9]) {
      const T = SL.compute(desk(3, n), MON, alg, quick(alg, { fidelity: 1, maxScale: 1.5 })).targets;
      const s = T.map(t => t.scale); worst = Math.max(worst, Math.max.apply(null, s) / Math.min.apply(null, s));
    }
    ok('push-apart, rows and the optimizer use one shared scale (size fidelity 1)', worst < 1 + 1e-9, 'largest ratio ' + worst.toFixed(6));
    const Tg = SL.compute(desk(3, 9), MON, 'grid').targets, sg = Tg.map(t => t.scale);
    ok('the equal grid scales windows unevenly (and is charged for it in the score)',
      Math.max.apply(null, sg) / Math.min.apply(null, sg) > 1.05 && SL.compute(desk(3, 9), MON, 'grid').score.sizes > 0);
  }

  section('Engine: equal grid cell assignment');
  {
    function perms(a) { if (a.length <= 1) return [a]; const out = []; a.forEach((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).forEach(p => out.push([x].concat(p)))); return out; }
    const dist = (T, ws) => { const by = new Map(ws.map(w => [w.id, w])); return T.reduce((q, t) => { const w = by.get(t.id); return q + Math.hypot(t.x + t.w / 2 - w.x - w.w / 2, t.y + t.h / 2 - w.y - w.h / 2); }, 0); };
    // the layout's cell centers are fixed; check no other assignment of windows to them is better
    let checked = 0, suboptimal = 0;
    for (const n of [2, 3, 4, 5, 6, 7]) for (const seed of [1, 2, 3, 4, 5]) {
      const ws = desk(seed + 40, n), T = SL.compute(ws, MON, 'grid').targets;
      const cells = T.map(t => [t.x + t.w / 2, t.y + t.h / 2]);
      let best = Infinity;
      for (const p of perms(ws.map((_, i) => i))) {
        let c = 0; p.forEach((wi, k) => { const w = ws[wi]; c += Math.hypot(cells[k][0] - w.x - w.w / 2, cells[k][1] - w.y - w.h / 2); });
        best = Math.min(best, c);
      }
      checked++; if (dist(T, ws) > best + 1e-6) suboptimal++;
    }
    ok('each window goes in its nearest cell: no other assignment has a smaller total distance', !suboptimal, 'brute force, ' + checked + ' desktops of 2-7 windows');
    // ties: identical windows on top of each other must still give an input-order-independent result
    const same = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, x: 500, y: 300, w: 800, h: 600 }));
    const a = SL.compute(same, MON, 'grid').targets, b = SL.compute(shuffled(same, 3), MON, 'grid').targets;
    ok('identical, stacked windows (all ties): result independent of input order', JSON.stringify(byId(a)) === JSON.stringify(byId(b)));
  }
  {
    // the assignment algorithm itself, on random cost matrices (including ties and negative costs)
    const factory = new Function(fs.readFileSync(ENGINE, 'utf8').replace(/return Object\.freeze\(\{/, 'return Object.freeze({ assignOptimal: assignOptimal,') + ';return createSpreadLayout;')();
    const assignOptimal = factory().assignOptimal;
    function perms(n) { const a = []; (function rec(p, used) { if (p.length === n) { a.push(p.slice()); return; } for (let i = 0; i < n; i++) if (!used[i]) { used[i] = 1; p.push(i); rec(p, used); p.pop(); used[i] = 0; } })([], []); return a; }
    let bad = 0, cases = 0; const r = SL.random(99);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) for (let k = 0; k < 12; k++) {
      const ties = k % 3 === 0, cost = Array.from({ length: n }, () => Array.from({ length: n }, () => ties ? Math.floor(r() * 3) : (r() - 0.3) * 100));
      const col = assignOptimal(cost), got = col.reduce((q, c, i) => q + cost[i][c], 0);
      const valid = col.slice().sort((x, y) => x - y).every((c, i) => c === i);
      const best = Math.min.apply(null, perms(n).map(p => p.reduce((q, c, i) => q + cost[i][c], 0)));
      cases++; if (!valid || got > best + 1e-9) bad++;
    }
    ok('the Hungarian method finds an optimal assignment', !bad, cases + ' random matrices up to 7×7, with ties and negative costs, against brute force');
  }

  section('Engine: monitors');
  {
    const ws = desk(4, 7), S = quick('anneal');
    const a = SL.compute(ws, MON, 'anneal', S);
    const b = SL.compute(ws.map(w => Object.assign({}, w, { x: w.x + 2560, y: w.y + 200 })), { x: 2560, y: 200, w: 1920, h: 1080 }, 'anneal', S);
    const dev = Math.max.apply(null, byId(a.targets).map((t, i) => { const u = byId(b.targets)[i]; return Math.max(Math.abs(u.x - t.x - 2560), Math.abs(u.y - t.y - 200), Math.abs(u.w - t.w)); }));
    ok('a monitor elsewhere (e.g. a second monitor) gives the same layout, shifted', dev < 1e-6, 'max deviation ' + dev.toExponential(1) + ' px');
  }

  section('Engine: settings at the edges of their ranges, small and odd monitors');
  {
    // Monitors as the extension passes them (after decorations), one of them not at 0,0;
    // windows random, all maximized (identical centers), or bigger than the monitor.
    const MONS = [{ x: 1920, y: 300, w: 1338, h: 718 }, { x: 0, y: 0, w: 1052, h: 1870 }];
    const SETS = [{}, { margin: 0 }, { margin: 200 }, { spacing: 0 }, { spacing: 58 }, { spacing: 130 },
      { fidelity: 0 }, { maxScale: 0.2 }, { centered: true }, { fill: true, growLimit: 3 }, { relMode: 'order' },
      { wRel: 0, wDisp: 0 }];
    const ALGS = [['anneal', {}], ['anneal', { restarts: 1, startFrom: 'rows' }], ['natural', {}],
      ['natural', { iterations: 10 }], ['rows', {}], ['rows', { rows: 1 }], ['rows', { rows: 8 }], ['grid', {}]];
    const frames = (mon, n, kind, seed) => {
      const r = SL.random(seed);
      return Array.from({ length: n }, (_, i) => {
        if (kind === 'max') return { id: i + 1, x: mon.x, y: mon.y, w: mon.w, h: mon.h };
        const big = kind === 'big', w = big ? mon.w * 1.3 : 200 + r() * 1100, h = big ? mon.h * 1.2 : 150 + r() * 700;
        return { id: i + 1, x: Math.round(mon.x + r() * Math.max(1, mon.w - w)), y: Math.round(mon.y + r() * Math.max(1, mon.h - h)),
          w: Math.round(w), h: Math.round(h) };
      });
    };
    let runs = 0, unusable = 0, overlaps = 0, tight = 0, outside = 0, tooBig = 0, threw = [], seed = 1;
    for (const mon of MONS) for (const S0 of SETS) for (const [alg, ov] of ALGS) for (const n of [1, 2, 6, 14]) for (const kind of ['rand', 'max', 'big']) {
      const S = SL.settings(alg, Object.assign(alg === 'anneal' ? { iterations: 1500 } : {}, S0, ov));
      let T; runs++;
      try { T = SL.compute(frames(mon, n, kind, seed++), mon, alg, S).targets; }
      catch (e) { threw.push(alg + ' ' + JSON.stringify(Object.assign({}, S0, ov)) + ': ' + e.message); continue; }
      const A = { x: mon.x + S.margin, y: mon.y + S.margin, w: mon.w - 2 * S.margin, h: mon.h - 2 * S.margin };
      for (const a of T) {
        if (![a.x, a.y, a.w, a.h].every(Number.isFinite) || !(a.w > 0 && a.h > 0)) { unusable++; continue; }
        if (a.x < A.x - 0.5 || a.y < A.y - 0.5 || a.x + a.w > A.x + A.w + 0.5 || a.y + a.h > A.y + A.h + 0.5) outside++;
        if (a.scale > S.maxScale + 1e-9) tooBig++;
        for (const b of T) if (a.id < b.id) {
          const gap = Math.max(Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)));
          if (gap < -0.01) overlaps++;
          else if (gap < S.spacing - 0.01 && S.spacing <= 58) tight++; // larger gaps: see the guarantees in the engine
        }
      }
    }
    ok('every layout is usable: finite positions, sizes above 0 (also with a fixed row count or a gap that leaves no room)',
      !unusable && !threw.length, runs + ' layouts' + (threw.length ? '; threw: ' + threw[0] : ''));
    ok('no overlaps, inside the margin, scale within the limit', !overlaps && !outside && !tooBig,
      overlaps + ' overlaps, ' + outside + ' outside, ' + tooBig + ' too big');
    ok('gaps at least the setting, up to the decorations of the default gap (58 px)', !tight, tight + ' pairs too close');
    const crowded = { x: 0, y: 0, w: 1338, h: 718 }, many = frames(crowded, 24, 'rand', 99);
    const fixed1 = SL.compute(many, crowded, 'rows', SL.settings('rows', { rows: 1, spacing: 58 })).targets;
    ok('ordered rows with a fixed row count that leaves no room falls back to the best row count',
      fixed1.every(t => t.w > 0) && new Set(fixed1.map(t => Math.round(t.y))).size > 1);
    let passes10 = 0;
    for (const n of [8, 16, 24]) for (const s of [1, 2, 3, 4]) {
      const T = SL.compute(frames({ x: 0, y: 0, w: 2532, h: 1390 }, n, 'rand', 500 + n * 10 + s), { x: 0, y: 0, w: 2532, h: 1390 },
        'natural', SL.settings('natural', { iterations: 10, spacing: 58 })).targets;
      for (const a of T) for (const b of T) if (a.id < b.id &&
        Math.max(Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))) < 58 - 0.01) passes10++;
    }
    ok('push-apart with its fewest passes (10) still keeps the gap', !passes10, passes10 + ' pairs too close');
    const bad = [[{ id: 1, x: 0, y: 0, w: 0, h: 0 }], [{ id: 1, x: NaN, y: 0, w: 10, h: 10 }]];
    const throwsFor = (ws, mon, S) => { try { SL.compute(ws, mon, 'natural', S); return false; } catch (e) { return true; } };
    ok('a window of size 0, a non-finite number, or a margin that leaves no area is an error, not an unusable layout',
      bad.every(ws => throwsFor(ws, MON)) &&
      throwsFor(desk(1, 3), { x: 0, y: 0, w: 300, h: 300 }, SL.settings('natural', { margin: 200 })));
    const ws5 = desk(5, 6), S5 = SL.settings('natural', { relMode: 'order' }), r5 = SL.compute(ws5, MON, 'natural', S5);
    ok('score() gives the same score as compute() returned',
      Math.abs(SL.score(r5.targets.map(t => Object.assign({ ow: ws5.find(w => w.id === t.id).w, oh: ws5.find(w => w.id === t.id).h }, t)), ws5, MON, S5).total - r5.score.total) < 1e-9);
  }

  section('Engine: optimizer safeguard');
  {
    let lostPush = 0, lostRows = 0, runs = 0;
    const starts = [[3, 'mixed'], [1, 'mixed'], [3, 'push'], [3, 'grid']];
    for (const step of [0.1, 0.3, 0.9]) for (const rowsCount of [0, 2]) for (const n of [4, 9, 13]) for (const [restarts, startFrom] of starts) {
      const ws = desk(n + rowsCount, n);
      const nat = SL.settings('natural', { step }), rows = SL.settings('rows', { rows: rowsCount });
      const opt = SL.settings('anneal', { iterations: 3000, restarts, startFrom,
        pushStart: { iterations: nat.iterations, step: nat.step, aspect: nat.aspect, polish: nat.polish }, rowsStart: { rows: rowsCount } });
      const a = SL.compute(ws, MON, 'anneal', opt).score.total; runs++;
      if (SL.compute(ws, MON, 'natural', nat).score.total < a - 1e-9) lostPush++;
      if (SL.compute(ws, MON, 'rows', rows).score.total < a - 1e-9) lostRows++;
    }
    ok('the optimizer never scores worse than push-apart or ordered rows with the same settings, whatever it starts from',
      !lostPush && !lostRows, runs + ' runs, push strength, row count, starts varied');
  }

  section('Engine: cache');
  {
    const ws = desk(5, 6), S = quick('anneal'), cache = SL.createCache();
    const fresh = JSON.stringify(SL.compute(ws, MON, 'anneal', S).targets);
    let r = cache.compute(ws, MON, 'anneal', S, 'm0/w1');
    ok('first call computes, with the same result as compute()', r.cached === false && JSON.stringify(r.targets) === fresh);
    ok('different window order (stacking) reuses it', cache.compute(shuffled(ws, 9), MON, 'anneal', S, 'm0/w1').cached === true);
    ok('extra fields (minimized, focus) are ignored', cache.compute(ws.map(w => Object.assign({ minimized: true }, w)), MON, 'anneal', S, 'm0/w1').cached === true);
    ok('settings the engine does not use are ignored', cache.compute(ws, MON, 'anneal', Object.assign({ duration: 900 }, S), 'm0/w1').cached === true);
    r = cache.compute(ws, MON, 'anneal', S, 'm0/w1'); r.targets[0].x = -999;
    ok('modifying a returned result does not affect the cache', cache.compute(ws, MON, 'anneal', S, 'm0/w1').targets[0].x !== -999);
    ok('moving a window by 1 px recomputes', cache.compute(ws.map((w, i) => i === 2 ? Object.assign({}, w, { x: w.x + 1 }) : w), MON, 'anneal', S, 'm0/w1').cached === false);
    ok('changing an engine setting recomputes', cache.compute(ws, MON, 'anneal', Object.assign({}, S, { spacing: S.spacing + 2 }), 'm0/w1').cached === false);
    const ws2 = desk(6, 3);
    cache.compute(ws, MON, 'anneal', S, 'm0/w1'); cache.compute(ws2, MON, 'anneal', S, 'm0/w2');
    ok('each slot (monitor and workspace) keeps its own layout',
      cache.compute(ws, MON, 'anneal', S, 'm0/w1').cached === true && cache.compute(ws2, MON, 'anneal', S, 'm0/w2').cached === true);
    cache.forget('m0/w1');
    ok('forget(slot) drops only that slot', cache.compute(ws, MON, 'anneal', S, 'm0/w1').cached === false && cache.compute(ws2, MON, 'anneal', S, 'm0/w2').cached === true);
  }

  section('Engine: rebuilt from its factory (as the lab\'s worker threads do)');
  {
    const factory = new Function(fs.readFileSync(ENGINE, 'utf8') + ';return createSpreadLayout;')();
    const rebuilt = new Function('return (' + factory.toString() + ')();')();
    const ws = desk(7, 9);
    ok('gives identical results', JSON.stringify(rebuilt.compute(ws, MON, 'anneal')) === JSON.stringify(SL.compute(ws, MON, 'anneal')));
  }

  section('Engine: timing (informational)');
  for (const n of [6, 12, 20]) {
    const ws = desk(8, n), t0 = Date.now();
    for (let k = 0; k < 3; k++) SL.compute(ws, MON, 'anneal');
    note(n + ' windows, default optimizer settings: ' + ((Date.now() - t0) / 3).toFixed(1) + ' ms per layout');
  }
}

module.exports = { run };
if (require.main === module) run().then(() => {
  const t = require('./lib/check').totals();
  console.log('\n' + t.passed + ' passed, ' + t.failed + ' failed');
  process.exit(t.failed ? 1 : 0);
});
