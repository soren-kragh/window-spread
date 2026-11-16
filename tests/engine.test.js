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
const quick = (alg, ov) => SL.settings(alg, Object.assign(alg === 'optimizer' ? { steps: 400 } : {}, ov || {}));

async function run() {
  section('Engine: API');
  ok('exposes DEFAULTS, ALGORITHMS, settings, compute, createCache, score, random',
    ['DEFAULTS', 'ALGORITHMS', 'settings', 'compute', 'createCache', 'score', 'random'].every(k => k in SL));
  ok('algorithms are optimizer, push, rows, grid', SL.ALGORITHMS.join() === 'optimizer,push,rows,grid');
  let frozen = true; try { SL.DEFAULTS.common.margin = -1; } catch (e) { /* strict mode throws */ }
  frozen = SL.DEFAULTS.common.margin !== -1;
  ok('DEFAULTS cannot be modified', frozen);
  const sa = SL.settings('optimizer');
  ok('settings("optimizer") includes the push-apart and rows start settings from their DEFAULTS',
    sa.pushStart.strength === SL.DEFAULTS.push.strength && sa.rowsStart.rows === SL.DEFAULTS.rows.rows);
  ok('empty input gives an empty result', SL.compute([], MON, 'optimizer').targets.length === 0);
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
          if (gap < 0) overlaps++; else if (gap < S.gap - 0.01) tightGaps++;
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
    let moved = 0;
    for (const n of [3, 8, 16]) for (const seed of [1, 2]) for (const [dx, dy] of [[2560, 200], [-1920, 37]]) {
      // whole pixels, as real window frames are (fractions would round differently once moved)
      const ws = desk(seed, n).map(w => ({ id: w.id, x: Math.round(w.x), y: Math.round(w.y), w: Math.round(w.w), h: Math.round(w.h) }));
      const S = quick(alg), T = SL.compute(ws, MON, alg, S).targets;
      const U = SL.compute(ws.map(w => Object.assign({}, w, { x: w.x + dx, y: w.y + dy })),
        { x: MON.x + dx, y: MON.y + dy, w: MON.w, h: MON.h }, alg, S).targets;
      if (T.some((t, i) => Math.abs(t.x + dx - U[i].x) > 1e-9 || Math.abs(t.y + dy - U[i].y) > 1e-9 || t.w !== U[i].w)) moved++;
    }
    ok(alg + ': the same layout wherever the monitor is (e.g. a second monitor)', !moved, moved + ' differ');
  }

  section('Engine: uniform scale');
  {
    let worst = 1;
    for (const alg of ['optimizer', 'push', 'rows']) for (const n of [4, 9]) {
      const T = SL.compute(desk(3, n), MON, alg, quick(alg, { fidelity: 1, maxScale: 1.5 })).targets;
      const s = T.map(t => t.scale); worst = Math.max(worst, Math.max.apply(null, s) / Math.min.apply(null, s));
    }
    ok('push-apart, rows and the optimizer use one shared scale (size fidelity 1)', worst < 1 + 1e-9, 'largest ratio ' + worst.toFixed(6));
    const Tg = SL.compute(desk(3, 9), MON, 'grid').targets, sg = Tg.map(t => t.scale);
    ok('the equal grid scales windows unevenly (and is charged for it in the score)',
      Math.max.apply(null, sg) / Math.min.apply(null, sg) > 1.05 && SL.compute(desk(3, 9), MON, 'grid').score.sizes > 0);
    // a few small windows on a big screen: all held at the max scale (DEVELOPMENT.md 5.4)
    const few = [{ id: 1, x: 100, y: 100, w: 400, h: 300 }, { id: 2, x: 900, y: 500, w: 700, h: 500 }, { id: 3, x: 300, y: 650, w: 250, h: 200 }];
    let held = true, charged = false;
    for (const alg of ['optimizer', 'push', 'rows']) for (const maxScale of [0.9, 1]) {
      const r = SL.compute(few, MON, alg, quick(alg, { maxScale }));
      if (!r.targets.every(t => Math.abs(t.scale - maxScale) < 1e-9)) held = false;
      if (r.score.sizes !== 0 || Math.abs(r.score.size + SL.DEFAULTS.scoring.wSize * Math.log(maxScale)) > 1e-12) charged = true;
    }
    ok('thumbnails held at the max scale (few small windows) count as their intended size: no uneven-size charge',
      held && !charged);
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
    const ws = desk(4, 7), S = quick('optimizer');
    const a = SL.compute(ws, MON, 'optimizer', S);
    const b = SL.compute(ws.map(w => Object.assign({}, w, { x: w.x + 2560, y: w.y + 200 })), { x: 2560, y: 200, w: 1920, h: 1080 }, 'optimizer', S);
    const dev = Math.max.apply(null, byId(a.targets).map((t, i) => { const u = byId(b.targets)[i]; return Math.max(Math.abs(u.x - t.x - 2560), Math.abs(u.y - t.y - 200), Math.abs(u.w - t.w)); }));
    ok('a monitor elsewhere (e.g. a second monitor) gives the same layout, shifted', dev < 1e-6, 'max deviation ' + dev.toExponential(1) + ' px');
  }

  section('Engine: center the arrangement');
  {
    // windows crowded at the left edge, with and without polish and gap filling
    const left = n => desk(5, n).map(w => Object.assign({}, w, { x: w.x / 4 }));
    const mon = { x: 100, y: 50, w: 1920, h: 1080 };
    let worst = 0, cases = 0;
    for (const alg of ['optimizer', 'push', 'rows']) for (const n of [1, 2, 5]) {
      for (const ov of [{}, { polish: false }, { fill: true }]) {
        const S = quick(alg, Object.assign({ centered: true }, ov));
        const T = SL.compute(left(n), mon, alg, S).targets;
        const x1 = Math.min.apply(null, T.map(t => t.x));
        const y1 = Math.min.apply(null, T.map(t => t.y));
        const x2 = Math.max.apply(null, T.map(t => t.x + t.w));
        const y2 = Math.max.apply(null, T.map(t => t.y + t.h));
        worst = Math.max(
          worst,
          Math.abs((x1 + x2) / 2 - (mon.x + mon.w / 2)),
          Math.abs((y1 + y2) / 2 - (mon.y + mon.h / 2))
        );
        cases++;
      }
    }
    ok(
      'push-apart, rows and the optimizer: the finished arrangement is centered ' +
        '(also after polish and gap filling)',
      worst < 1e-6,
      cases + ' layouts of windows at the left edge, worst off-center ' +
        worst.toExponential(1) + ' px'
    );
    // centering is only a final move: the same layout as without it, shifted
    let notShift = 0, runs = 0;
    for (const alg of ['optimizer', 'push', 'rows']) for (const n of [2, 5, 9]) for (const seed of [1, 2]) {
      for (const ov of [{}, { fill: true }, { relationsMethod: 'order' }]) {
        const ws = desk(seed, n), a = SL.compute(ws, mon, alg, quick(alg, ov)).targets;
        const b = SL.compute(ws, mon, alg, quick(alg, Object.assign({ centered: true }, ov))).targets;
        const dx = b[0].x - a[0].x, dy = b[0].y - a[0].y;
        if (b.some((t, i) => Math.abs(t.x - a[i].x - dx) > 1e-9 || Math.abs(t.y - a[i].y - dy) > 1e-9 ||
          t.w !== a[i].w || t.h !== a[i].h)) notShift++;
        runs++;
      }
    }
    ok('centering moves the finished layout as a whole: otherwise the same layout as without it',
      !notShift, notShift + ' of ' + runs + ' differ');
  }

  section('Engine: settings at the edges of their ranges, small and odd monitors');
  {
    // Monitors as the extension passes them (after decorations), one of them not at 0,0;
    // windows random, all maximized (identical centers), or bigger than the monitor.
    const MONS = [{ x: 1920, y: 300, w: 1338, h: 718 }, { x: 0, y: 0, w: 1052, h: 1870 }];
    const SETS = [{}, { margin: 0 }, { margin: 200 }, { gap: 0 }, { gap: 58 }, { gap: 130 },
      { gap: 0, extraGapX: 28, extraGapY: 50 }, { gap: 8, extraGapX: 50, extraGapY: 28 },
      { fill: true, maxGrowth: 3, extraGapX: 28, extraGapY: 50 },
      { fidelity: 0 }, { maxScale: 0.2 }, { centered: true }, { fill: true, maxGrowth: 3 }, { relationsMethod: 'order' },
      { wRelations: 0, wPlace: 0 }];
    const ALGS = [['optimizer', {}], ['optimizer', { starts: 1, startFrom: 'rows' }], ['push', {}],
      ['push', { passes: 10 }], ['rows', {}], ['rows', { rows: 1 }], ['rows', { rows: 8 }], ['grid', {}]];
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
      const S = SL.settings(alg, Object.assign(alg === 'optimizer' ? { steps: 150 } : {}, S0, ov));
      let T; runs++;
      try { T = SL.compute(frames(mon, n, kind, seed++), mon, alg, S).targets; }
      catch (e) { threw.push(alg + ' ' + JSON.stringify(Object.assign({}, S0, ov)) + ': ' + e.message); continue; }
      const A = { x: mon.x + S.margin, y: mon.y + S.margin, w: mon.w - 2 * S.margin, h: mon.h - 2 * S.margin };
      for (const a of T) {
        if (![a.x, a.y, a.w, a.h].every(Number.isFinite) || !(a.w > 0 && a.h > 0)) { unusable++; continue; }
        if (a.x < A.x - 0.5 || a.y < A.y - 0.5 || a.x + a.w > A.x + A.w + 0.5 || a.y + a.h > A.y + A.h + 0.5) outside++;
        if (a.scale > S.maxScale + 1e-9) tooBig++;
        const gx = S.gap + S.extraGapX, gy = S.gap + S.extraGapY;
        for (const b of T) if (a.id < b.id) {
          const sx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), sy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
          if (Math.max(sx, sy) < -0.01) overlaps++;
          // larger gaps: see the guarantees in the engine
          else if (sx < gx - 0.01 && sy < gy - 0.01 && Math.max(gx, gy) <= 58) tight++;
        }
      }
    }
    ok('every layout is usable: finite positions, sizes above 0 (also with a fixed row count or a gap that leaves no room)',
      !unusable && !threw.length, runs + ' layouts' + (threw.length ? '; threw: ' + threw[0] : ''));
    ok('no overlaps, inside the margin, scale within the limit', !overlaps && !outside && !tooBig,
      overlaps + ' overlaps, ' + outside + ' outside, ' + tooBig + ' too big');
    ok('gaps at least the settings (also with extra gaps side by side or one above the other), up to 58 px (more than the default gap plus decorations)', !tight, tight + ' pairs too close');
    const crowded = { x: 0, y: 0, w: 1338, h: 718 }, many = frames(crowded, 24, 'rand', 99);
    const fixed1 = SL.compute(many, crowded, 'rows', SL.settings('rows', { rows: 1, gap: 58 })).targets;
    ok('ordered rows with a fixed row count that leaves no room falls back to the best row count',
      fixed1.every(t => t.w > 0) && new Set(fixed1.map(t => Math.round(t.y))).size > 1);
    let passes10 = 0;
    for (const n of [8, 16, 24]) for (const s of [1, 2, 3, 4]) {
      const T = SL.compute(frames({ x: 0, y: 0, w: 2532, h: 1390 }, n, 'rand', 500 + n * 10 + s), { x: 0, y: 0, w: 2532, h: 1390 },
        'push', SL.settings('push', { passes: 10, gap: 58 })).targets;
      for (const a of T) for (const b of T) if (a.id < b.id &&
        Math.max(Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))) < 58 - 0.01) passes10++;
    }
    ok('push-apart with its fewest passes (10) still keeps the gap', !passes10, passes10 + ' pairs too close');
    { // gaps that leave no room: the polish must not turn "too close" into an overlap
      const ws11 = [[471, 96, 81, 402], [400, 16, 67, 105], [268, 89, 447, 303], [160, 289, 658, 234], [308, 279, 695, 127],
        [180, 230, 712, 156], [531, 122, 499, 144], [409, 133, 453, 441], [478, 195, 220, 479], [245, 28, 579, 454],
        [225, 44, 545, 202]].map(([x, y, w, h], i) => ({ id: i + 1, x, y, w, h }));
      const T = SL.compute(ws11, { x: 0, y: 0, w: 808, h: 448 }, 'push',
        SL.settings('push', { gap: 3, extraGapX: 0, extraGapY: 181, margin: 8, wPlace: 10, wRelations: 0 })).targets;
      let worst = 0;
      for (const a of T) for (const b of T) if (a.id < b.id) {
        worst = Math.min(worst, Math.max(Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))));
      }
      ok('with unequal gaps that leave no room, the polish creates no overlap', worst > -1e-6, 'closest pair ' + worst.toFixed(3) + ' px');
    }
    { // crowded (20 windows on a portrait monitor, 58 px gap): the gap takes many rounds to settle
      const mon = { x: 0, y: 0, w: 1052, h: 1870 }, R = SL.random(3 * 97 + 20);
      const ws20 = Array.from({ length: 20 }, (_, i) => {
        const w = 300 + R() * 1100, h = 200 + R() * 700;
        return { id: i + 1, x: Math.round(R() * Math.max(1, mon.w - w)), y: Math.round(R() * Math.max(1, mon.h - h)), w: Math.round(w), h: Math.round(h) };
      });
      const T = SL.compute(ws20, mon, 'optimizer', SL.settings('optimizer', { gap: 58 })).targets;
      let ratio = 1;
      for (const a of T) for (const b of T) if (a.id < b.id) {
        ratio = Math.min(ratio, Math.max(Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))) / 58);
      }
      ok('on a crowded screen the gap is still reached (gap widening runs until it settles)', ratio >= 0.9999, 'smallest gap ' + (ratio * 100).toFixed(2) + '% of the setting');
    }
    const bad = [[{ id: 1, x: 0, y: 0, w: 0, h: 0 }], [{ id: 1, x: NaN, y: 0, w: 10, h: 10 }]];
    const throwsFor = (ws, mon, S) => { try { SL.compute(ws, mon, 'push', S); return false; } catch (e) { return true; } };
    ok('a window of size 0, a non-finite number, or a margin that leaves no area is an error, not an unusable layout',
      bad.every(ws => throwsFor(ws, MON)) &&
      throwsFor(desk(1, 3), { x: 0, y: 0, w: 300, h: 300 }, SL.settings('push', { margin: 200 })));
    const refused = ov => { try { SL.compute(desk(1, 4), MON, 'optimizer', SL.settings('optimizer', ov)); return false; } catch (e) { return /unusable setting/.test(e.message); } };
    const badSettings = [{ maxScale: 0 }, { fidelity: NaN }, { gap: -1 }, { extraGapX: -1 }, { extraGapY: -1 }, { firstStep: 0 }, { checkpoint: 0 },
      { relationsMethod: 'angles' }, { startFrom: 'top' }, { steps: 0 }, { pushStart: { passes: 1000, strength: 0, matchShape: 0.5, polish: true } }];
    ok('settings outside their allowed values are an error, not an unusable layout',
      badSettings.every(refused) && !refused({ maxScale: 0.2, fidelity: 0, gap: 0, checkpoint: 1, neighborFocus: 1 }), badSettings.length + ' cases');
    const ws5 = desk(5, 6), S5 = SL.settings('push', { relationsMethod: 'order' }), r5 = SL.compute(ws5, MON, 'push', S5);
    ok('score() gives the same score as compute() returned',
      Math.abs(SL.score(r5.targets.map(t => Object.assign({ ow: ws5.find(w => w.id === t.id).w, oh: ws5.find(w => w.id === t.id).h }, t)), ws5, MON, S5).total - r5.score.total) < 1e-9);
  }

  section('Engine: optimizer safeguard');
  {
    let lostPush = 0, lostRows = 0, runs = 0;
    const starts = [[3, 'mixed'], [1, 'mixed'], [3, 'push'], [3, 'rows'], [3, 'grid'], [3, 'none']];
    for (const strength of [0.1, 0.3, 0.9]) for (const rowsCount of [0, 2]) for (const n of [4, 9, 13]) for (const [nStarts, startFrom] of starts) {
      const ws = desk(n + rowsCount, n);
      const push = SL.settings('push', { strength }), rows = SL.settings('rows', { rows: rowsCount });
      const opt = SL.settings('optimizer', { steps: 300, starts: nStarts, startFrom,
        pushStart: { passes: push.passes, strength: push.strength, matchShape: push.matchShape, polish: push.polish }, rowsStart: { rows: rowsCount } });
      const a = SL.compute(ws, MON, 'optimizer', opt).score.total; runs++;
      if (SL.compute(ws, MON, 'push', push).score.total < a - 1e-9) lostPush++;
      if (SL.compute(ws, MON, 'rows', rows).score.total < a - 1e-9) lostRows++;
    }
    ok('the optimizer never scores worse than push-apart or ordered rows with the same settings, whatever it starts from',
      !lostPush && !lostRows, runs + ' runs, push strength, row count, starts varied');
  }

  section('Engine: cache');
  {
    const ws = desk(5, 6), S = quick('optimizer'), cache = SL.createCache();
    const fresh = JSON.stringify(SL.compute(ws, MON, 'optimizer', S).targets);
    let r = cache.compute(ws, MON, 'optimizer', S, 'm0/w1');
    ok('first call computes, with the same result as compute()', r.cached === false && JSON.stringify(r.targets) === fresh);
    ok('different window order (stacking) reuses it', cache.compute(shuffled(ws, 9), MON, 'optimizer', S, 'm0/w1').cached === true);
    ok('extra fields (minimized, focus) are ignored', cache.compute(ws.map(w => Object.assign({ minimized: true }, w)), MON, 'optimizer', S, 'm0/w1').cached === true);
    ok('settings the engine does not use are ignored', cache.compute(ws, MON, 'optimizer', Object.assign({ duration: 900 }, S), 'm0/w1').cached === true);
    r = cache.compute(ws, MON, 'optimizer', S, 'm0/w1'); r.targets[0].x = -999;
    ok('modifying a returned result does not affect the cache', cache.compute(ws, MON, 'optimizer', S, 'm0/w1').targets[0].x !== -999);
    ok('moving a window by 1 px recomputes', cache.compute(ws.map((w, i) => i === 2 ? Object.assign({}, w, { x: w.x + 1 }) : w), MON, 'optimizer', S, 'm0/w1').cached === false);
    ok('changing an engine setting recomputes', cache.compute(ws, MON, 'optimizer', Object.assign({}, S, { gap: S.gap + 2 }), 'm0/w1').cached === false);
    const ws2 = desk(6, 3);
    cache.compute(ws, MON, 'optimizer', S, 'm0/w1'); cache.compute(ws2, MON, 'optimizer', S, 'm0/w2');
    ok('each slot (monitor and workspace) keeps its own layout',
      cache.compute(ws, MON, 'optimizer', S, 'm0/w1').cached === true && cache.compute(ws2, MON, 'optimizer', S, 'm0/w2').cached === true);
    cache.forget('m0/w1');
    ok('forget(slot) drops only that slot', cache.compute(ws, MON, 'optimizer', S, 'm0/w1').cached === false && cache.compute(ws2, MON, 'optimizer', S, 'm0/w2').cached === true);
  }

  section('Engine: rebuilt from its factory (as the lab\'s worker threads do)');
  {
    const factory = new Function(fs.readFileSync(ENGINE, 'utf8') + ';return createSpreadLayout;')();
    const rebuilt = new Function('return (' + factory.toString() + ')();')();
    const ws = desk(7, 9);
    ok('gives identical results', JSON.stringify(rebuilt.compute(ws, MON, 'optimizer')) === JSON.stringify(SL.compute(ws, MON, 'optimizer')));
  }

  section('Engine: timing (informational)');
  for (const n of [6, 12, 20]) {
    const ws = desk(8, n), t0 = Date.now();
    for (let k = 0; k < 3; k++) SL.compute(ws, MON, 'optimizer');
    note(n + ' windows, default optimizer settings: ' + ((Date.now() - t0) / 3).toFixed(1) + ' ms per layout');
  }
}

module.exports = { run };
if (require.main === module) run().then(() => {
  const t = require('./lib/check').totals();
  console.log('\n' + t.passed + ' passed, ' + t.failed + ' failed');
  process.exit(t.failed ? 1 : 0);
});
