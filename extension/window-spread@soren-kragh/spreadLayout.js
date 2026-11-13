/* ==========================================================================
   SPREAD LAYOUT ENGINE
   ==========================================================================
   Computes where window thumbnails go in a "show all windows" spread.

   This file is self-contained: plain JavaScript, no DOM, no browser APIs, no
   dependencies. It is the only copy of the engine: the Cinnamon extension uses it
   directly, and the lab page (lab/window-spread-lab.html) loads this same file.

   Loading
     Cinnamon extension: on 6.8 and later through
       `imports.ui.extension.getCurrentExtension().imports.spreadLayout.SpreadLayout`
       (GJS's native importer exposes the top-level `var SpreadLayout`); on 6.0-6.6
       `require('./spreadLayout')` (Cinnamon's loader provides require() and
       module.exports).
     Browser: <script src=".../spreadLayout.js">; defines the global `SpreadLayout`.
     Web Worker: the lab rebuilds the engine from `createSpreadLayout.toString()`.
     Node (tests): `require("./spreadLayout.js")`.

   Public API
     SpreadLayout.DEFAULTS
         All default settings ("knobs"), grouped as common / scoring / one group per
         algorithm. See section 1 below; this is the place to change defaults.
     SpreadLayout.ALGORITHMS
         ["anneal", "natural", "rows", "grid"]
     SpreadLayout.settings(algorithm, overrides?)
         Settings object for one algorithm: common + scoring + that algorithm's defaults,
         then `overrides` on top. For "anneal" it also contains pushStart and rowsStart:
         the settings of the push-apart and ordered-rows layouts it can start from
         (defaults: DEFAULTS.natural and DEFAULTS.rows).
     SpreadLayout.compute(windows, monitor, algorithm, settings?)
         windows    [{ id, x, y, w, h }]  real window frames: finite numbers, sizes
                    above 0. ids must be unique numbers; other fields are ignored.
         monitor    { x, y, w, h }  the area the spread may use, typically one monitor's
                    work area (without panels), in the same coordinates as the windows.
         algorithm  one of SpreadLayout.ALGORITHMS.
         settings   flat object as returned by SpreadLayout.settings(); omitted = defaults.
         returns    { targets: [{ id, x, y, w, h, scale }],   one per window: where its
                                                             thumbnail goes; scale = w / real w
                      score:   { total, size, sizes, move, rel, overlap },  lower is better
                      info:    diagnostics, see compute() below }
     SpreadLayout.createCache()
         Optional helper that remembers the last layout per "slot" (for example one slot per
         monitor and workspace) and reuses it when nothing relevant has changed:
           const cache = SpreadLayout.createCache();
           cache.compute(windows, monitor, algorithm, settings, slot)  -> same as compute(),
                       plus `cached: true` when the previous layout of that slot was reused
           cache.forget(slot), cache.clear()
         Reused only on an exact match of the windows (ids and frames), the monitor area, the
         algorithm and the engine settings. The order of `windows` never matters, so changes
         in stacking or focus keep using the cached layout.
     SpreadLayout.score(targets, windows, monitor, settings)
         Score any layout (lower is better), with the same parts as above. With `centered`,
         compute() scores its layout before the final centering, so scoring its targets
         here can give a different (worse) movement part.
     SpreadLayout.random(seed)
         The engine's deterministic random generator (returns a function giving [0, 1)).
         Exposed for generating reproducible test data.

   Minimized windows
     Pass them like any other window, with their normal (unminimized) frame. The engine has no
     notion of minimized state, so minimizing or restoring a window never changes the layout.

   Guarantees
     - Only window positions and sizes are read. Stacking order and focus history are
       never used: windows are processed in an order derived from geometry alone.
     - Deterministic: the same input and settings always give the same result.
     - Thumbnails never overlap, keep at least `spacing` px between them, and stay inside
       the monitor area minus `margin`.
     - The optimizer ("anneal") never scores worse than the push-apart and ordered-rows
       layouts, when given the same settings as those algorithms (pushStart /
       rowsStart; gap filling, if on, comes after this comparison).
     - Input it can't lay out (a non-finite number, a window or work area of size 0)
       makes compute() throw instead of returning an unusable layout.

   Not done here (left to the caller)
     - Animation, drawing, input handling, multi-monitor assignment.
     - A time budget: effort is a fixed number of moves (`anneal.iterations`), set
       by the user; see DEVELOPMENT.md 5.19.
   ========================================================================== */
// All engine code lives inside this factory function, so that it can also be handed to
// Web Workers as text (createSpreadLayout.toString()) without keeping a second copy.
function createSpreadLayout() {
"use strict";

/* --------------------------------------------------------------------------
   1. SETTINGS (the knobs)
   Change defaults here. Every value can also be overridden per call through
   SpreadLayout.settings(algorithm, overrides).
   -------------------------------------------------------------------------- */
const DEFAULTS = {
  // Used by every algorithm.
  common: {
    margin: 16,        // px of empty border kept inside the monitor area
    spacing: 8,        // px minimum gap between thumbnails
    fidelity: 0.8,       // relative sizes: 1 = exact, 0 = all thumbnails same area, 0.5 = area ratios square-rooted
    maxScale: 0.9,     // largest thumbnail scale; 1 = never bigger than the real window
    centered: false,   // true: always center the arrangement; false: move it toward the real windows
    fill: false,       // afterwards, grow thumbnails into free space (makes sizes uneven)
    growLimit: 1.5,    // fill: maximum growth factor per thumbnail
  },
  // What a good layout is. Used by the optimizer's search, by the polish step and by score().
  // Only the balance between the weights matters.
  scoring: {
    wScale: 4,         // reward for bigger thumbnails
    wSizes: 5,         // penalty for uneven scaling (sizes no longer match the real windows)
    wDisp: 2,          // penalty for thumbnails far from their real window
    wRel: 1,           // penalty for windows changing how they sit relative to each other
    relMode: "direction",  // relations measured as "order" (left/right, above/below) or "direction" (angles)
    relNear: 0.5,      // direction mode only: 0 = all pairs count equally, 1 = nearby pairs matter most
  },
  // Optimizer (simulated annealing).
  anneal: {
    iterations: 10000, // total random moves, shared by all parallel starts (the effort / time knob)
    restarts: 3,       // parallel starts racing each other
    checkpoint: 0.2,   // point of the cooling schedule (0..1) where the first weak starts are dropped
    temp: 0.1,        // starting temperature: willingness to accept worse moves early on
    seed: 1,           // random seed; same seed + same input = same result
    bailout: true,     // drop the worse half of the starts at each checkpoint
    polish: true,      // greedy final polish
    startFrom: "mixed", // "push" | "rows" | "grid" | "none" (real positions) | "mixed" (one kind per start)
    // pushStart, rowsStart: settings of the push-apart and ordered-rows layouts the optimizer can
    // start from. Filled in by settings() from DEFAULTS.natural and DEFAULTS.rows; pass the same
    // values as those algorithms use, so the optimizer is guaranteed to do at least as well.
  },
  // Push apart ("natural").
  natural: {
    iterations: 1000,  // maximum push-apart passes
    step: 0.3,         // push strength per pass (fraction of the overlap)
    aspect: 0.5,       // bias pushes toward the screen's shape (0 = straight apart)
    polish: true,      // greedy final polish
  },
  // Ordered rows.
  rows: {
    rows: 0,           // number of rows; 0 = choose automatically
  },
  // Equal grid. No settings of its own: each window always goes in the cell nearest to it.
  grid: {},
};

/* --------------------------------------------------------------------------
   2. INTERNAL CONSTANTS
   Fixed details of the algorithms. Not meant as user settings; changing them
   changes behavior in ways the lab has not been tuned for.
   -------------------------------------------------------------------------- */
const INTERNAL = {
  // Push-apart (resolve)
  PUSH_NUDGE: 0.5,                                   // px added to every push so progress never stalls
  START_RESOLVE: { iterations: 1000, step: 0.5 },   // overlap removal for the optimizer's rows / grid starts
  CLEANUP: { iterations: 2000, step: 0.5 },          // final overlap removal
  // Gap handling: the gap must be chosen in unscaled units before the final scale is known.
  DENSITY_GUESS: 0.5,                                // expected share of the screen covered, for the first gap guess
  GAP_ROUNDS: 8,                                     // max rounds of widening the gap until it is right
  GAP_OVERSHOOT: 1.003,                              // widen slightly more than needed, to converge quickly
  // Seeds used only to break exact ties (windows with identical centers)
  SEED_TIES: 12345, SEED_CLEANUP: 1, SEED_GAP: 7,
  // Optimizer
  START_KINDS: ["push", "rows", "grid", "none"],     // rotation used by startFrom "mixed"
  COOL_TO: 1e-3,                                     // final temperature as a fraction of the starting temperature
  MOVE_MIN: 0.02, MOVE_HOT: 0.5,                     // move size (fraction of average window size): cold + hot part
  // Aimed moves: a share of moves jump a random part of the way toward the window's "home" (where
  // its real center lands in the current arrangement) instead of a random direction. Helps a lot
  // on crowded desktops (same quality with 2-4x fewer moves at 16-24 windows), slightly hurts on
  // small ones, so the share ramps from 0 at AIM_FROM_N windows to AIM_SHARE at AIM_FULL_N.
  AIM_SHARE: 0.25, AIM_FROM_N: 6, AIM_FULL_N: 14, AIM_JITTER: 0.3,
  CHAIN_SEED_A: 7919, CHAIN_SEED_B: 104729,          // per-start random seeds: seed * A + start * B
  // Scoring
  W_OVERLAP: 40,                                     // overlap penalty (only matters inside the optimizer's search)
  W_REL: 4, W_DISTORT: 2,                            // internal scale of the relations and size-distortion terms
  NEAR: 0.1,                                         // direction mode: "nearby" distance, fraction of the screen diagonal
  // Polish
  POLISH_PASSES: 60, POLISH_FIRST_STEP: 0.5, POLISH_MIN_STEP: 1, // passes; first step (x avg size); smallest step px
  // Fill gaps
  FILL_BISECT: 24,                                   // bisection steps when growing a thumbnail
};

/* --------------------------------------------------------------------------
   3. SMALL HELPERS
   -------------------------------------------------------------------------- */
// Deterministic pseudo-random generator (mulberry32). Returns a function giving [0, 1).
function random(seed) {
  let a = seed | 0;
  return function () {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Thumbnail rectangle from its center; ow/oh carry the real window size along.
const rectC = (id, cx, cy, w, h, ow, oh) => ({ id, x: cx - w / 2, y: cy - h / 2, w, h, ow, oh });
// Bounding box of center-based rectangles {x, y, w, h}.
function bounds(R) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of R) {
    x1 = Math.min(x1, r.x - r.w / 2); y1 = Math.min(y1, r.y - r.h / 2);
    x2 = Math.max(x2, r.x + r.w / 2); y2 = Math.max(y2, r.y + r.h / 2);
  }
  return { x1, y1, x2, y2 };
}
// Overlap area of center-based rectangles i and j, given center and size arrays.
function overlapArea(X, Y, W, H, i, j) {
  const ox = (W[i] + W[j]) / 2 - Math.abs(X[i] - X[j]), oy = (H[i] + H[j]) / 2 - Math.abs(Y[i] - Y[j]);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

// Optimal assignment (Hungarian method, O(n^3)): for an n×n cost matrix, returns colOf[row]
// such that the sum of cost[row][colOf[row]] is as small as possible. Deterministic.
function assignOptimal(cost) {
  const n = cost.length, INF = Infinity;
  const u = new Float64Array(n + 1), v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1), way = new Int32Array(n + 1); // p[col] = row (1-based), 0 = free
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(INF), used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const colOf = new Array(n);
  for (let j = 1; j <= n; j++) colOf[p[j] - 1] = j - 1;
  return colOf;
}

/* --------------------------------------------------------------------------
   4. SHARED PREPARATION
   -------------------------------------------------------------------------- */
// Canonical processing order, derived only from geometry: center y, center x, width,
// height, then id for exact duplicates. Stacking order is never read.
function canonical(ws) {
  return ws.slice().sort((a, b) =>
    (a.y + a.h / 2) - (b.y + b.h / 2) || (a.x + a.w / 2) - (b.x + b.w / 2) || a.w - b.w || a.h - b.h || a.id - b.id);
}
// Per window: real size (ow, oh), real center (cx, cy), size-fidelity factor f and the
// "layout size" (lw, lh) = real size * f, in which all uniform-scale algorithms work.
function prep(ws, S) {
  const items = canonical(ws).map(w => ({ id: w.id, ow: w.w, oh: w.h, cx: w.x + w.w / 2, cy: w.y + w.h / 2 }));
  const amax = Math.max(...items.map(i => i.ow * i.oh));
  for (const it of items) {
    it.f = Math.pow(amax / (it.ow * it.oh), (1 - S.fidelity) / 2);
    it.lw = it.ow * it.f; it.lh = it.oh * it.f;
  }
  return items;
}
// The usable area: monitor minus margin. Center and diagonal are the monitor's.
function workArea(monitor, margin) {
  return {
    x: monitor.x + margin, y: monitor.y + margin, w: monitor.w - 2 * margin, h: monitor.h - 2 * margin,
    cx: monitor.x + monitor.w / 2, cy: monitor.y + monitor.h / 2, diag: Math.hypot(monitor.w, monitor.h),
  };
}
// First guess of the gap in layout units (the final scale is not known yet).
function estPad(items, S, A) {
  const sum = items.reduce((s, i) => s + i.lw * i.lh, 0);
  const est = Math.min(1, Math.sqrt(A.w * A.h * INTERNAL.DENSITY_GUESS / sum));
  return S.spacing / est;
}

/* --------------------------------------------------------------------------
   5. PUSH-APART PRIMITIVES
   Layout-space rectangles R: { x, y } = center, { w, h } = layout size + gap ("pad").
   -------------------------------------------------------------------------- */
// Push overlapping pairs apart until nothing overlaps (or maxIter passes). `aspect` biases
// pushes toward the work area's shape. Returns the number of passes used.
function resolve(R, maxIter, step, aspect, A, rng) {
  const target = A.w / A.h;
  let it = 0;
  for (; it < maxIter; it++) {
    let bx = 1, by = 1;
    if (aspect > 0) {
      const b = bounds(R), ratio = target / ((b.x2 - b.x1) / (b.y2 - b.y1));
      if (ratio > 1) bx = Math.pow(ratio, aspect); else by = Math.pow(1 / ratio, aspect);
    }
    let moved = false;
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
      const a = R[i], c = R[j];
      let dx = c.x - a.x, dy = c.y - a.y;
      const ox = (a.w + c.w) / 2 - Math.abs(dx), oy = (a.h + c.h) / 2 - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;
      moved = true;
      if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) { const g = rng() * Math.PI * 2; dx = Math.cos(g); dy = Math.sin(g); }
      dx *= bx; dy *= by;
      const len = Math.hypot(dx, dy); dx /= len; dy /= len;
      // distance along (dx, dy) that separates the pair
      const need = Math.min(Math.abs(dx) > 1e-9 ? ox / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? oy / Math.abs(dy) : Infinity);
      const amt = (step * need + INTERNAL.PUSH_NUDGE) / 2;
      a.x -= dx * amt; a.y -= dy * amt; c.x += dx * amt; c.y += dy * amt;
    }
    if (!moved) break;
  }
  return it;
}
// If the real final scale is larger than first guessed, the on-screen gap would be too
// small: widen the padding to what the real scale needs and push apart again.
function enforceGap(items, R, A, S) {
  // Overlaps left when the push-apart hit its pass limit (none otherwise: then this
  // returns at once)
  resolve(R, INTERNAL.CLEANUP.iterations, INTERNAL.CLEANUP.step, 0, A, random(INTERNAL.SEED_GAP));
  let pad = R.length ? R[0].w - items[0].lw : 0;
  for (let k = 0; k < INTERNAL.GAP_ROUNDS; k++) {
    const b = bounds(R), s = Math.min(A.w / (b.x2 - b.x1 - pad), A.h / (b.y2 - b.y1 - pad));
    const need = S.spacing / s;
    if (need <= pad * 1.0001 + 1e-9) break;
    pad = need * INTERNAL.GAP_OVERSHOOT;
    items.forEach((it, i) => { R[i].w = it.lw + pad; R[i].h = it.lh + pad; });
    resolve(R, INTERNAL.CLEANUP.iterations, INTERNAL.CLEANUP.step, 0, A, random(INTERNAL.SEED_GAP));
  }
}
// Scale the arrangement uniformly so the windows (not their padding) fill the work area,
// centered. Returns thumbnail rectangles.
function finalize(items, R, A, S) {
  const pad = R.length ? R[0].w - items[0].lw : 0;
  const b = bounds(R);
  const s = Math.min(A.w / (b.x2 - b.x1 - pad), A.h / (b.y2 - b.y1 - pad));
  const bcx = (b.x1 + b.x2) / 2, bcy = (b.y1 + b.y2) / 2;
  return items.map((it, i) => {
    const sc = Math.min(s * it.f, S.maxScale);
    return rectC(it.id, A.cx + (R[i].x - bcx) * s, A.cy + (R[i].y - bcy) * s, it.ow * sc, it.oh * sc, it.ow, it.oh);
  });
}

/* --------------------------------------------------------------------------
   6. SCORING
   One score for any finished layout; lower is better. Shared by all algorithms,
   the optimizer's search (in layout units) and the polish step.
   -------------------------------------------------------------------------- */
// Direction method: penalty of a pair with weight wt and real direction (unit
// vector ux, uy) that now points along (ndx, ndy): 0 if the same, wt if
// opposite.
const dirPen = (wt, ux, uy, ndx, ndy) => {
  const d = Math.sqrt(ndx * ndx + ndy * ndy);
  return d < 1e-6 ? wt * 0.5 : wt * (1 - (ux * ndx + uy * ndy) / d) / 2;
};
// Relations term, shared by the scorer and the optimizer. O* = real centers and
// sizes, NW/NH = current sizes (thumbnail or layout sizes). Returns
// pen(X, Y, i, j) for current centers X, Y, and the normalizer relNorm (sum of
// pair weights). Direction method (rows: true): the pair values also come as
// n×n row arrays, for hot loops to read directly. For window i and another
// window j, at k = i * n + j, RW[k] is the pair's weight and (RUX[k], RUY[k])
// the real unit direction from i to j; dirPen takes them with (ndx, ndy) =
// center of j minus center of i.
function makeRelations(OX, OY, OW, OH, NW, NH, S, diag) {
  const n = OX.length, order = S.relMode === "order", relOn = S.wRel > 0;
  const rows = relOn && !order;
  const pairs = order ? new Array(n * n) : null;
  const RW = rows ? new Float64Array(n * n) : null;
  const RUX = rows ? new Float64Array(n * n) : null;
  const RUY = rows ? new Float64Array(n * n) : null;
  let relNorm = 0;
  if (relOn) {
    const near = INTERNAL.NEAR * diag;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const odx = OX[j] - OX[i], ody = OY[j] - OY[i], d = Math.sqrt(odx * odx + ody * ody);
      if (order) {
        // Confidence that the pair is side by side (cx) or one above the other (cy): how clearly
        // they are separated along that axis, times how much the pair is oriented along it
        // (cos² / sin² of the angle between them). Two windows far apart at almost the same
        // height are side by side, not "above" each other, so their vertical order barely counts.
        const pr = { sx: Math.sign(odx), sy: Math.sign(ody) };
        const hx = d > 1e-6 ? (odx * odx) / (d * d) : 0, hy = d > 1e-6 ? (ody * ody) / (d * d) : 0;
        pr.cx = Math.min(1, Math.abs(odx) / ((OW[i] + OW[j]) / 4)) * hx;
        pr.cy = Math.min(1, Math.abs(ody) / ((OH[i] + OH[j]) / 4)) * hy;
        pr.nx = (NW[i] + NW[j]) / 4; pr.ny = (NH[i] + NH[j]) / 4;
        pr.wt = pr.cx + pr.cy;
        relNorm += pr.wt; pairs[i * n + j] = pr;
      } else {
        const ux = d > 1e-6 ? odx / d : 0, uy = d > 1e-6 ? ody / d : 0;
        const wt = d > 1e-6 ? Math.pow(near / (d + near), 4 * S.relNear) : 0;
        const a = i * n + j, b = j * n + i;
        RW[a] = RW[b] = wt;
        RUX[a] = ux; RUX[b] = -ux;
        RUY[a] = uy; RUY[b] = -uy;
        relNorm += wt;
      }
    }
  }
  const pen = (X, Y, p, q) => {
    if (!order) {
      const k = p * n + q, wt = RW[k];
      return wt ? dirPen(wt, RUX[k], RUY[k], X[q] - X[p], Y[q] - Y[p]) : 0;
    }
    const i = p < q ? p : q, j = p < q ? q : p, pr = pairs[i * n + j];
    if (!pr.wt) return 0;
    // 0 while the order is kept, up to the pair's weight once clearly flipped
    const ndx = X[j] - X[i], ndy = Y[j] - Y[i];
    return (
      pr.cx * clamp(-pr.sx * ndx / pr.nx, 0, 1) +
      pr.cy * clamp(-pr.sy * ndy / pr.ny, 0, 1)
    );
  };
  return { relOn, relNorm, pen, rows, RW, RUX, RUY };
}
// Scorer for thumbnails T (sizes fixed): parts(X, Y) for full scores, plus the
// pieces the polish evaluates itself (real centers OX/OY, relations, and the
// weights kDisp, kRel, kOv of the movement, relations and overlap terms).
function makeScorer(T, ws, S, A) {
  const by = new Map(ws.map(w => [w.id, w])), n = T.length, O = T.map(t => by.get(t.id));
  const amax = Math.max(...O.map(w => w.w * w.h));
  const f = O.map(w => Math.pow(amax / (w.w * w.h), (1 - S.fidelity) / 2));
  const OX = O.map(w => w.x + w.w / 2), OY = O.map(w => w.y + w.h / 2);
  const Wt = T.map(t => t.w), Ht = T.map(t => t.h);
  const sumA = T.reduce((q, t) => q + t.w * t.h, 0) || 1;
  // Log scale of each thumbnail, after removing the intended size-fidelity
  // factor. A thumbnail held at maxScale counts as large as the largest one
  // that isn't (as maxScale if all are): the limit, not the layout, keeps it
  // from its intended size, so it costs neither size nor evenness.
  const lr = O.map((w, i) => Math.log(Wt[i] / w.w / f[i]));
  const capped = O.map((w, i) => Wt[i] / w.w >= S.maxScale * (1 - 1e-9));
  let top = -Infinity;
  for (let i = 0; i < n; i++) if (!capped[i]) top = Math.max(top, lr[i]);
  if (top === -Infinity) top = Math.log(S.maxScale);
  for (let i = 0; i < n; i++) if (capped[i]) lr[i] = Math.max(lr[i], top);
  // size: mean -ln(scale)
  let size = 0;
  for (let i = 0; i < n; i++) size -= Math.min(lr[i], Math.log(S.maxScale));
  size /= Math.max(1, n);
  // size distortion: mean absolute deviation of the log scale; 0 when all share one scale
  const lmean = lr.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const distortion = lr.reduce((a, v) => a + Math.abs(v - lmean), 0) / Math.max(1, n);
  const rel = makeRelations(OX, OY, O.map(w => w.w), O.map(w => w.h), Wt, Ht, S, A.diag);
  const dist = (X, Y, i) => { const dx = X[i] - OX[i], dy = Y[i] - OY[i]; return Math.sqrt(dx * dx + dy * dy); };
  const kDisp = S.wDisp * 2 / Math.max(1, n) / A.diag;
  const kRel = rel.relNorm > 0 ? S.wRel * INTERNAL.W_REL / rel.relNorm : 0;
  const kOv = INTERNAL.W_OVERLAP / sumA;
  function parts(X, Y) {
    let d = 0, r = 0, o = 0;
    for (let i = 0; i < n; i++) {
      d += dist(X, Y, i);
      for (let j = i + 1; j < n; j++) { if (rel.relOn) r += rel.pen(X, Y, i, j); o += overlapArea(X, Y, Wt, Ht, i, j); }
    }
    const p = { size: S.wScale * size, sizes: S.wSizes * INTERNAL.W_DISTORT * distortion, move: kDisp * d, rel: kRel * r, overlap: kOv * o };
    p.total = p.size + p.sizes + p.move + p.rel + p.overlap;
    return p;
  }
  return { parts, Wt, Ht, n, OX, OY, rel, kDisp, kRel, kOv };
}
function scoreLayout(T, ws, S, A) {
  return makeScorer(T, ws, S, A).parts(T.map(t => t.x + t.w / 2), T.map(t => t.y + t.h / 2));
}

/* --------------------------------------------------------------------------
   7. ALGORITHMS
   Each takes (windows, settings, work area, info) and returns thumbnail rectangles
   { id, x, y, w, h, ow, oh }. `info` collects diagnostics.
   -------------------------------------------------------------------------- */
// Equal grid: equal cells, each window shrunk to fit its own cell (scales windows unevenly;
// ignores size fidelity). Each window goes in the cell nearest to it: the assignment with the
// smallest total distance between windows' real centers and their cells' centers (Hungarian
// method), so the arrangement follows where windows are, never the stacking order.
function layoutGrid(ws, S, A) {
  const items = prep(ws, { ...S, fidelity: 1 });
  const n = items.length, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), g = S.spacing;
  // Gaps between cells; where the gap setting leaves no room for the cells, the gaps
  // shrink to take half the width (or height).
  const gx = A.w - g * (cols - 1) > 0 ? g : A.w / 2 / (cols - 1);
  const gy = A.h - g * (rows - 1) > 0 ? g : A.h / 2 / (rows - 1);
  const cw = (A.w - gx * (cols - 1)) / cols, ch = (A.h - gy * (rows - 1)) / rows;
  // cell centers, row by row; the last row is centered if it isn't full
  const cells = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols, inRow = Math.min(cols, n - r * cols);
    const off = (cols - inRow) * (cw + gx) / 2;
    cells.push({ x: A.x + off + c * (cw + gx) + cw / 2, y: A.y + r * (ch + gy) + ch / 2 });
  }
  const cellOf = assignOptimal(items.map(it => cells.map(c => Math.hypot(it.cx - c.x, it.cy - c.y))));
  return items.map((it, k) => {
    const cell = cells[cellOf[k]], sc = Math.min(cw / it.ow, ch / it.oh, S.maxScale);
    return rectC(it.id, cell.x, cell.y, it.ow * sc, it.oh * sc, it.ow, it.oh);
  });
}

// Push apart: start at the real positions, push overlapping pairs apart,
// scale the whole arrangement uniformly to fit.
function layoutNatural(ws, S, A, info) {
  const items = prep(ws, S), pad = estPad(items, S, A);
  const R = items.map(it => ({ x: it.cx, y: it.cy, w: it.lw + pad, h: it.lh + pad }));
  const it = resolve(R, S.iterations, S.step, S.aspect, A, random(INTERNAL.SEED_TIES));
  info.iterations = it; info.hitLimit = it >= S.iterations;
  enforceGap(items, R, A, S);
  return finalize(items, R, A, S);
}

// Ordered rows: rows top to bottom by vertical position, left to right within a row;
// the row count giving the largest uniform scale wins (or S.rows if set).
function layoutRows(ws, S, A) {
  const items = prep(ws, S), n = items.length, g = S.spacing;
  const byY = items.slice().sort((a, b) => a.cy - b.cy || a.cx - b.cx || a.id - b.id);
  const total = byY.reduce((s, i) => s + i.lw, 0);
  // r rows, filled in reading order; s = the scale at which they fit
  const tryRows = r => {
    const buckets = Array.from({ length: r }, () => []);
    let acc = 0;
    for (const it of byY) { const mid = acc + it.lw / 2; acc += it.lw; buckets[Math.min(r - 1, Math.floor(mid / (total / r)))].push(it); }
    const rows = buckets.filter(b => b.length).map(b => b.sort((a, c) => a.cx - c.cx || a.id - c.id));
    let s = Infinity, sumH = 0;
    for (const row of rows) {
      s = Math.min(s, (A.w - g * (row.length - 1)) / row.reduce((q, i) => q + i.lw, 0));
      sumH += Math.max(...row.map(i => i.lh));
    }
    s = Math.min(s, (A.h - g * (rows.length - 1)) / sumH);
    return { s, rows };
  };
  const fixed = S.rows | 0;
  let best = fixed > 0 ? tryRows(Math.min(fixed, n)) : null;
  if (!best || !(best.s > 0)) { // automatic, also when the fixed row count leaves no room
    best = null;
    for (let r = 1; r <= n; r++) {
      const t = tryRows(r);
      if (!best || t.s > best.s + 1e-9) best = t;
    }
  }
  if (!(best.s > 0)) throw new Error("ordered rows: the gaps leave no room for the windows");
  const { s, rows } = best, out = [];
  const H = rows.reduce((q, row) => q + Math.max(...row.map(i => i.lh)) * s, 0) + g * (rows.length - 1);
  let y = A.cy - H / 2;
  for (const row of rows) {
    const rh = Math.max(...row.map(i => i.lh)) * s;
    const rw = row.reduce((q, i) => q + i.lw * s, 0) + g * (row.length - 1);
    let x = A.cx - rw / 2;
    for (const it of row) {
      const sc = Math.min(s * it.f, S.maxScale);
      out.push(rectC(it.id, x + it.lw * s / 2, y + rh / 2, it.ow * sc, it.oh * sc, it.ow, it.oh));
      x += it.lw * s + g;
    }
    y += rh + g;
  }
  return out;
}

// Optimizer: simulated annealing over window centers in layout units (one shared scale,
// exact relative sizes). Several starts race; at checkpoints the worse half is dropped.
function layoutAnneal(ws, S, A, info, shared) {
  const items = prep(ws, S), n = items.length, pad = estPad(items, S, A);
  const R0 = items.map(it => ({ x: it.cx, y: it.cy, w: it.lw + pad, h: it.lh + pad }));
  if (n < 2) return finalize(items, R0, A, S);

  // Starting points. "none" = real (overlapping) positions; "push" = push-apart with the
  // push-apart algorithm's settings (S.pushStart); "rows" / "grid" = those layouts' centers
  // with their overall scale undone, then overlaps resolved (true-size windows can be too
  // big for grid cells). The push-apart and ordered-rows layouts are also handed
  // to the safeguard (`shared`), which would otherwise compute them again.
  const startCache = {};
  const startPos = kind => {
    if (startCache[kind]) return startCache[kind];
    const R = R0.map(r => ({ ...r })), push = S.pushStart, P = INTERNAL.START_RESOLVE;
    if (kind === "push") { // = the push-apart algorithm's first step
      const rng = random(INTERNAL.SEED_TIES);
      resolve(R, push.iterations, push.step, push.aspect, A, rng);
      shared.push = { items, R: R.map(r => ({ ...r })) };
    } else if (kind === "rows" || kind === "grid") {
      let T;
      try {
        T = kind === "rows" ? layoutRows(ws, { ...S, rows: S.rowsStart.rows }, A) : layoutGrid(ws, S, A);
      } catch (e) { // no room for ordered rows: start from the push-apart layout instead
        return (startCache[kind] = startPos("push"));
      }
      if (kind === "rows") shared.rows = T;
      const byId = new Map(T.map(t => [t.id, t]));
      let ls = 0;
      for (const it of items) ls += Math.log(byId.get(it.id).w / it.lw);
      const s0 = Math.exp(ls / n);
      items.forEach((it, i) => { const t = byId.get(it.id); R[i].x = (t.x + t.w / 2) / s0; R[i].y = (t.y + t.h / 2) / s0; });
      resolve(R, P.iterations, P.step, 0, A, random(INTERNAL.SEED_TIES));
    }
    return (startCache[kind] = { X: Float64Array.from(R, r => r.x), Y: Float64Array.from(R, r => r.y) });
  };
  const KINDS = INTERNAL.START_KINDS;
  const kindOf = c => S.startFrom === "mixed" ? KINDS[c % KINDS.length] : (S.startFrom || "push");

  const W = Float64Array.from(R0, r => r.w), H = Float64Array.from(R0, r => r.h);
  const OX = Float64Array.from(items, it => it.cx), OY = Float64Array.from(items, it => it.cy);
  const sumA = R0.reduce((s, r) => s + r.w * r.h, 0);
  const avg = R0.reduce((s, r) => s + Math.sqrt(r.w * r.h), 0) / n;
  const T0 = S.temp;
  const rel = makeRelations(OX, OY, items.map(it => it.ow), items.map(it => it.oh), items.map(it => it.lw), items.map(it => it.lh), S, A.diag);
  const relOn = rel.relOn, relPen = rel.pen;
  const relRows = rel.rows, RW = rel.RW, RUX = rel.RUX, RUY = rel.RUY;

  // The same score as scoreLayout(), computed in layout units: the arrangement is scaled to
  // fit and placed as the pipeline will place it (centered, or toward the real windows).
  const cost = (ch, ovT = ch.ov, relT = ch.rel) => {
    const X = ch.X, Y = ch.Y;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (let i = 0; i < n; i++) {
      const hw = W[i] / 2, hh = H[i] / 2;
      if (X[i] - hw < x1) x1 = X[i] - hw; if (X[i] + hw > x2) x2 = X[i] + hw;
      if (Y[i] - hh < y1) y1 = Y[i] - hh; if (Y[i] + hh > y2) y2 = Y[i] + hh;
    }
    const s = Math.min(A.w / (x2 - x1 - pad), A.h / (y2 - y1 - pad)), bcx = (x1 + x2) / 2, bcy = (y1 + y2) / 2;
    let px = A.cx, py = A.cy;
    if (!S.centered) { // placement toward the real windows, as far as the work area allows
      let mx = 0, my = 0;
      for (let i = 0; i < n; i++) { mx += OX[i] - (X[i] - bcx) * s; my += OY[i] - (Y[i] - bcy) * s; }
      const hw = (x2 - x1 - pad) * s / 2, hh = (y2 - y1 - pad) * s / 2;
      px = clamp(mx / n, A.x + hw, A.x + A.w - hw); py = clamp(my / n, A.y + hh, A.y + A.h - hh);
    }
    ch.ps = s; ch.pbx = bcx; ch.pby = bcy; ch.ppx = px; ch.ppy = py; // placement, for aimed moves
    let d = 0;
    for (let i = 0; i < n; i++) {
      const dx = px + (X[i] - bcx) * s - OX[i], dy = py + (Y[i] - bcy) * s - OY[i];
      d += Math.sqrt(dx * dx + dy * dy);
    }
    return -Math.log(Math.min(s, S.maxScale)) * S.wScale + S.wDisp * 2 * d / n / A.diag + INTERNAL.W_OVERLAP * ovT / sumA
      + (rel.relNorm > 0 ? S.wRel * INTERNAL.W_REL * relT / rel.relNorm : 0);
  };

  // One independent search ("start"). Pair values (overlap, relation penalty) are cached in
  // OV / RL, so a move only computes the moved window's new pair values.
  const makeChain = c => {
    const kind = kindOf(c), sp = startPos(kind);
    const ch = { c, kind, X: sp.X.slice(), Y: sp.Y.slice(),
      rng: random((S.seed * INTERNAL.CHAIN_SEED_A + c * INTERNAL.CHAIN_SEED_B) | 0),
      spare: null, steps: 0, accepted: 0, ov: 0, rel: 0 };
    ch.OV = new Float64Array(n * n); ch.RL = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const o = overlapArea(ch.X, ch.Y, W, H, i, j), r = relOn ? relPen(ch.X, ch.Y, i, j) : 0;
      ch.OV[i * n + j] = ch.OV[j * n + i] = o; ch.RL[i * n + j] = ch.RL[j * n + i] = r;
      ch.ov += o; ch.rel += r;
    }
    ch.cur = ch.best = cost(ch); ch.bestX = ch.X.slice(); ch.bestY = ch.Y.slice();
    return ch;
  };
  const gauss = ch => { // normal random numbers (Box-Muller, two per draw)
    if (ch.spare !== null) { const v = ch.spare; ch.spare = null; return v; }
    const u = Math.max(ch.rng(), 1e-12), v = ch.rng(), m = Math.sqrt(-2 * Math.log(u));
    ch.spare = m * Math.sin(2 * Math.PI * v); return m * Math.cos(2 * Math.PI * v);
  };
  // One move. All starts share one cooling schedule of length L, so at any checkpoint
  // they are compared at the same temperature.
  const newO = new Float64Array(n), newR = new Float64Array(n);
  const aimShare = INTERNAL.AIM_SHARE * clamp((n - INTERNAL.AIM_FROM_N) / (INTERNAL.AIM_FULL_N - INTERNAL.AIM_FROM_N), 0, 1);
  const step = (ch, L) => {
    if (ch.T === undefined) { ch.T = T0; ch.cool = Math.pow(INTERNAL.COOL_TO, 1 / L); }
    const T = ch.T; ch.T *= ch.cool; ch.steps++;
    const X = ch.X, Y = ch.Y, rng = ch.rng, OV = ch.OV, RL = ch.RL;
    const i = (rng() * n) | 0, px = X[i], py = Y[i], row = i * n;
    const sig = avg * (INTERNAL.MOVE_MIN + INTERNAL.MOVE_HOT * T / T0);
    if (aimShare > 0 && rng() < aimShare) { // jump part of the way toward the window's home
      const hx = (OX[i] - ch.ppx) / ch.ps + ch.pbx, hy = (OY[i] - ch.ppy) / ch.ps + ch.pby, u = rng();
      X[i] += (hx - X[i]) * u + gauss(ch) * sig * INTERNAL.AIM_JITTER;
      Y[i] += (hy - Y[i]) * u + gauss(ch) * sig * INTERNAL.AIM_JITTER;
    } else { X[i] += gauss(ch) * sig; Y[i] += gauss(ch) * sig; }
    let dO = 0, dR = 0;
    for (let j = 0; j < n; j++) if (j !== i) {
      const o = overlapArea(X, Y, W, H, i, j); newO[j] = o; dO += o - OV[row + j];
      if (relRows) { // = relPen(X, Y, i, j), read straight from the row arrays
        const k = row + j, wt = RW[k];
        const r = wt ? dirPen(wt, RUX[k], RUY[k], X[j] - X[i], Y[j] - Y[i]) : 0;
        newR[j] = r; dR += r - RL[k];
      } else if (relOn) {
        const r = relPen(X, Y, i, j); newR[j] = r; dR += r - RL[row + j];
      }
    }
    const c = cost(ch, ch.ov + dO, ch.rel + dR);
    if (c <= ch.cur || rng() < Math.exp((ch.cur - c) / T)) {
      ch.cur = c; ch.accepted++; ch.ov += dO; ch.rel += dR;
      for (let j = 0; j < n; j++) if (j !== i) { OV[row + j] = OV[j * n + i] = newO[j]; if (relOn) RL[row + j] = RL[j * n + i] = newR[j]; }
      if (c < ch.best) { ch.best = c; ch.bestX.set(X); ch.bestY.set(Y); }
    } else { X[i] = px; Y[i] = py; }
  };

  // Race. counts = starts alive per round; checkpoints q at fractions of the schedule
  // (first at S.checkpoint, then evenly to the end). L is chosen so the total number of
  // moves equals S.iterations.
  const K = Math.max(1, Math.round(S.restarts)), N = S.iterations;
  const counts = [K];
  if (S.bailout) while (counts[counts.length - 1] > 1) counts.push(Math.ceil(counts[counts.length - 1] / 2));
  const rounds = counts.length;
  const q = counts.map((_, r) => rounds === 1 ? 1 : S.checkpoint + (1 - S.checkpoint) * r / (rounds - 1));
  q[rounds - 1] = 1;
  const L = N / counts.reduce((s, k, r) => s + k * (q[r] - (r ? q[r - 1] : 0)), 0);
  const chains = Array.from({ length: K }, (_, c) => makeChain(c));
  let alive = chains.slice();
  for (let r = 0; r < rounds; r++) {
    const until = Math.round(q[r] * L);
    for (const ch of alive) while (ch.steps < until) step(ch, L);
    if (r + 1 < rounds) { alive.sort((a, b) => a.best - b.best || a.c - b.c); alive = alive.slice(0, counts[r + 1]); }
  }
  const win = chains.reduce((a, b) => b.best < a.best ? b : a);

  const R = R0.map((r, i) => ({ x: win.bestX[i], y: win.bestY[i], w: r.w, h: r.h }));
  resolve(R, INTERNAL.CLEANUP.iterations, INTERNAL.CLEANUP.step, 0, A, random(INTERNAL.SEED_CLEANUP)); // no overlap may remain
  enforceGap(items, R, A, S);
  info.starts = K; info.winningStart = win.c + 1; info.winningKind = win.kind;
  info.startsPerRound = counts; info.acceptRate = win.accepted / Math.max(1, win.steps);
  return finalize(items, R, A, S);
}

const ALGORITHMS = {
  //        run function    uniformScale: one scale for all windows   polishable: may use the polish step
  anneal:  { run: layoutAnneal,  uniformScale: true,  polishable: true },
  natural: { run: layoutNatural, uniformScale: true,  polishable: true },
  rows:    { run: layoutRows,    uniformScale: true,  polishable: false },
  grid:    { run: layoutGrid,    uniformScale: false, polishable: false },
};

/* --------------------------------------------------------------------------
   8. POST-STEPS (applied by compute() after the algorithm)
   -------------------------------------------------------------------------- */
// Move the finished arrangement as a whole toward the real window positions, as far as the
// work area allows. Sizes and shape are unchanged.
function placeNearReal(T, ws, A) {
  const by = new Map(ws.map(w => [w.id, w]));
  let mx = 0, my = 0, x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const t of T) {
    const w = by.get(t.id);
    mx += (w.x + w.w / 2) - (t.x + t.w / 2); my += (w.y + w.h / 2) - (t.y + t.h / 2);
    x1 = Math.min(x1, t.x); y1 = Math.min(y1, t.y); x2 = Math.max(x2, t.x + t.w); y2 = Math.max(y2, t.y + t.h);
  }
  const dx = clamp(mx / T.length, A.x - x1, A.x + A.w - x2), dy = clamp(my / T.length, A.y - y1, A.y + A.h - y2);
  return T.map(t => ({ ...t, x: t.x + dx, y: t.y + dy }));
}

// Move the finished arrangement as a whole so it is centered in the work area:
// equal margins left and right, and top and bottom. Sizes and shape are
// unchanged.
function centerLayout(T, A) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const t of T) {
    x1 = Math.min(x1, t.x); y1 = Math.min(y1, t.y);
    x2 = Math.max(x2, t.x + t.w); y2 = Math.max(y2, t.y + t.h);
  }
  const dx = A.cx - (x1 + x2) / 2, dy = A.cy - (y1 + y2) / 2;
  return T.map(t => ({ ...t, x: t.x + dx, y: t.y + dy }));
}

// Greedy polish: small moves in 8 directions with shrinking steps, kept only if
// they lower the score. A thumbnail only moves into free space: never closer to
// a neighbor than the gap (or than it already was), never outside the work
// area.
//
// Only the score terms involving the moving thumbnail change, so a move is
// judged by local() of that thumbnail before and after. The work is kept small
// without changing any result (it is exactly that of checking every move
// against every other thumbnail):
// * local() at the current position is computed once, not per candidate move.
// * Only neighbors within reach of the step (near list) can block or overlap.
// * Overlap terms are exactly 0 while nothing overlaps, and skipped then.
// * A thumbnail whose last scan found nothing is skipped until another moves.
function polishLayout(T, ws, S, A) {
  const sc = makeScorer(T, ws, S, A), n = sc.n, g = S.spacing;
  if (n < 1) return { T, moved: 0, gain: 0 };
  const Wt = Float64Array.from(sc.Wt), Ht = Float64Array.from(sc.Ht);
  const X = Float64Array.from(T, t => t.x + t.w / 2);
  const Y = Float64Array.from(T, t => t.y + t.h / 2);
  const OX = sc.OX, OY = sc.OY, kDisp = sc.kDisp, kRel = sc.kRel, kOv = sc.kOv;
  const rel = sc.rel, relOn = rel.relOn, rows = rel.rows;
  const RW = rel.RW, RUX = rel.RUX, RUY = rel.RUY;
  const ax1 = A.x - 0.5, ax2 = A.x + A.w + 0.5;
  const ay1 = A.y - 0.5, ay2 = A.y + A.h + 0.5;
  const avg = sc.Wt.reduce((q, w, i) => q + Math.sqrt(w * Ht[i]), 0) / n;
  const step0 = avg * INTERNAL.POLISH_FIRST_STEP;
  // Separation of thumbnail i at (x, y) from thumbnail j: the larger of the two
  // axis gaps; negative when they overlap.
  const sep = (i, j, x, y) => Math.max(
    Math.abs(x - X[j]) - (Wt[i] + Wt[j]) / 2,
    Math.abs(y - Y[j]) - (Ht[i] + Ht[j]) / 2
  );
  // Some pair overlaps (only possible if overlap removal hit its limit). While
  // false, every overlap term is exactly 0.
  let anyOv = false;
  for (let i = 0; i < n && !anyOv; i++) for (let j = i + 1; j < n; j++) {
    if (sep(i, j, X[i], Y[i]) < 0) { anyOv = true; break; }
  }
  // Score terms involving thumbnail i, with i at (x, y); the same sum, in the
  // same order, as the full score (the skipped terms are exactly 0). full:
  // include the overlap terms.
  const local = (i, x, y, full) => {
    const dx = x - OX[i], dy = y - OY[i];
    let v = kDisp * Math.sqrt(dx * dx + dy * dy);
    if (rows && !full) {
      for (let j = 0, k = i * n; j < n; j++, k++) {
        const wt = RW[k];
        if (wt) v += kRel * dirPen(wt, RUX[k], RUY[k], X[j] - x, Y[j] - y);
      }
    } else if (relOn || full) {
      const px = X[i], py = Y[i];
      X[i] = x; Y[i] = y;
      for (let j = 0; j < n; j++) if (j !== i) {
        if (relOn) v += kRel * rel.pen(X, Y, i, j);
        if (full) v += kOv * overlapArea(X, Y, Wt, Ht, i, j);
      }
      X[i] = px; Y[i] = py;
    }
    return v;
  };
  // Near list of thumbnail i: the neighbors a move of up to step0 could bring
  // closer than allowed, nearest first, with their current separation (nearS)
  // and the separation a move must keep (nearT). A neighbor whose separation is
  // at least gap + step stays farther than the gap after any move of that step,
  // so it can neither block the move nor overlap.
  const REACH = 1e-3; // px of safety margin on that reach
  const nearJ = new Int32Array(n);
  const nearS = new Float64Array(n), nearT = new Float64Array(n);
  let nearN = 0;
  const findNear = i => {
    nearN = 0;
    const lim = g + step0 + REACH;
    for (let j = 0; j < n; j++) if (j !== i) {
      const s = sep(i, j, X[i], Y[i]);
      if (s >= lim) continue;
      let k = nearN++;
      for (; k > 0 && nearS[k - 1] > s; k--) {
        nearJ[k] = nearJ[k - 1];
        nearS[k] = nearS[k - 1];
        nearT[k] = nearT[k - 1];
      }
      nearJ[k] = j; nearS[k] = s; nearT[k] = Math.min(g, s) - 1e-6;
    }
  };
  const DX = [1, -1, 0, 0, .7071, .7071, -.7071, -.7071];
  const DY = [0, 0, 1, -1, .7071, -.7071, .7071, -.7071];
  // idleAt[i]: value of `moved` when thumbnail i was last scanned without
  // moving. While nothing has moved since, a new scan would find nothing again.
  const idleAt = new Int32Array(n).fill(-1);
  let moved = 0, gain = 0;
  for (let pass = 0; pass < INTERNAL.POLISH_PASSES; pass++) {
    let improved = false;
    for (let i = 0; i < n; i++) {
      if (idleAt[i] === moved) continue;
      const moved0 = moved, hw = Wt[i] / 2, hh = Ht[i] / 2;
      let before = 0, haveBefore = false;
      findNear(i);
      for (let step = step0; step >= INTERNAL.POLISH_MIN_STEP; step /= 2) {
        const lim = g + step + REACH;
        for (let d = 0; d < 8; d++) {
          const nx = X[i] + DX[d] * step, ny = Y[i] + DY[d] * step;
          if (nx - hw < ax1 || nx + hw > ax2) continue;
          if (ny - hh < ay1 || ny + hh > ay2) continue;
          let fits = true, minSep = Infinity;
          for (let k = 0; k < nearN && nearS[k] < lim; k++) {
            const s = sep(i, nearJ[k], nx, ny);
            if (s < nearT[k]) { fits = false; break; }
            if (s < minSep) minSep = s;
          }
          if (!fits) continue;
          if (!haveBefore) {
            before = local(i, X[i], Y[i], anyOv);
            haveBefore = true;
          }
          const after = local(i, nx, ny, anyOv || minSep < 0);
          const dl = after - before;
          if (dl < -1e-9) {
            X[i] = nx; Y[i] = ny; gain -= dl; moved++; improved = true;
            before = after;
            if (minSep < 0) anyOv = true;
            findNear(i);
          }
        }
      }
      if (moved === moved0) idleAt[i] = moved;
    }
    if (!improved) break;
  }
  return {
    T: T.map((t, i) => ({ ...t, x: X[i] - Wt[i] / 2, y: Y[i] - Ht[i] / 2 })),
    moved,
    gain
  };
}

// Optimizer safeguard: build the push-apart and ordered-rows layouts (with their
// own settings, S.pushStart / S.rowsStart; whether or not the search started
// from them), finish them with the same post-steps, and keep whatever scores
// best. A candidate is polished if either the optimizer or that algorithm
// polishes, and polishing only ever lowers a score, so the optimizer is never
// worse than those algorithms. The grid is not a candidate: its uneven scaling
// is not something the optimizer may produce.
//
// Where the search built these layouts as starting points, they come from it
// (`shared`), identical to building them here. A candidate's polish is skipped
// when even its best possible polished score could not win (polishLowerBound):
// the same outcome as polishing it and losing.
function optimizerSafeguard(T, ws, S, A, info, shared) {
  let best = T, bestScore = scoreLayout(T, ws, S, A).total, from = null;
  for (const k of ["push", "rows"]) {
    let C;
    if (k === "rows") {
      try {
        C = shared.rows || layoutRows(ws, { ...S, rows: S.rowsStart.rows }, A);
      } catch (e) { continue; } // no room for ordered rows: nothing to compare with
    } else if (shared.push) { // the push-apart algorithm's remaining steps
      const p = shared.push;
      enforceGap(p.items, p.R, A, S);
      C = finalize(p.items, p.R, A, S);
    } else {
      const P = S.pushStart;
      C = layoutNatural(
        ws,
        { ...S, iterations: P.iterations, step: P.step, aspect: P.aspect },
        A,
        {}
      );
    }
    if (!S.centered) C = placeNearReal(C, ws, A);
    if (S.polish || (k === "push" && S.pushStart.polish)) {
      // cannot win, polished or not
      if (polishLowerBound(C, ws, S, A) >= bestScore + 1e-9) continue;
      C = polishLayout(C, ws, S, A).T;
    }
    const sc = scoreLayout(C, ws, S, A).total;
    if (sc < bestScore - 1e-12) { best = C; bestScore = sc; from = k; }
  }
  info.keptStart = from; // null: the search's own result was best
  return best;
}

// A score that polishing C can never get below. The polish doesn't change
// sizes, so the size terms stay as they are; the relations and overlap terms
// are at least 0 (up to rounding, far below the caller's 1e-9 margin); and the
// movement term is at least what pairs of thumbnails that would be too close at
// their real positions force on them:
// * The polish never brings two thumbnails closer than min(gap, their
//   separation in C), less 1e-6 px per move (its tolerance); `slack` covers the
//   most moves it can make.
// * For a pair to stay that far apart, the distances of the two from their real
//   positions must add up to at least m (the shortfall along the axis that is
//   cheaper to fix).
// * Over pairs that share no thumbnail these add up; they are picked largest m
//   first.
function polishLowerBound(C, ws, S, A) {
  const sc = makeScorer(C, ws, S, A), n = sc.n, OX = sc.OX, OY = sc.OY;
  const X = C.map(t => t.x + t.w / 2), Y = C.map(t => t.y + t.h / 2);
  const p = sc.parts(X, Y);
  const avg = C.reduce((q, t) => q + Math.sqrt(t.w * t.h), 0) / Math.max(1, n);
  let steps = 0;
  const minStep = INTERNAL.POLISH_MIN_STEP;
  for (let s = avg * INTERNAL.POLISH_FIRST_STEP; s >= minStep; s /= 2) steps++;
  const slack = 1e-6 * INTERNAL.POLISH_PASSES * n * steps * 8 + 1e-3;
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = (C[i].w + C[j].w) / 2, b = (C[i].h + C[j].h) / 2;
    const s0 = Math.max(Math.abs(X[i] - X[j]) - a, Math.abs(Y[i] - Y[j]) - b);
    const r = Math.min(S.spacing, s0) - slack;
    const m = Math.min(
      a + r - Math.abs(OX[i] - OX[j]),
      b + r - Math.abs(OY[i] - OY[j])
    );
    if (m > 0) pairs.push([m, i, j]);
  }
  pairs.sort((u, v) => v[0] - u[0] || u[1] - v[1] || u[2] - v[2]);
  const taken = new Uint8Array(n);
  let move = 0;
  for (const [m, i, j] of pairs) {
    if (taken[i] || taken[j]) continue;
    taken[i] = taken[j] = 1; move += m;
  }
  return p.size + p.sizes + sc.kDisp * move;
}

// Optional: let each thumbnail (smallest first) grow into free space, up to S.growLimit.
function fillGaps(T, S, A) {
  const g = S.spacing;
  const order = T.map((_, i) => i).sort((a, b) => T[a].w * T[a].h - T[b].w * T[b].h || T[a].y - T[b].y || T[a].x - T[b].x);
  const hits = (r, i) => {
    if (r.x < A.x - 0.5 || r.y < A.y - 0.5 || r.x + r.w > A.x + A.w + 0.5 || r.y + r.h > A.y + A.h + 0.5) return true;
    for (let j = 0; j < T.length; j++) {
      if (j === i) continue;
      const o = T[j];
      if (r.x < o.x + o.w + g && o.x < r.x + r.w + g && r.y < o.y + o.h + g && o.y < r.y + r.h + g) return true;
    }
    return false;
  };
  for (const i of order) {
    const t = T[i], cur = t.w / t.ow, maxG = Math.min(S.growLimit, S.maxScale / cur);
    if (maxG <= 1) continue;
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    let lo = 1, hi = maxG;
    const at = k => rectC(t.id, cx, cy, t.w * k, t.h * k, t.ow, t.oh);
    if (!hits(at(hi), i)) lo = hi;
    else for (let k = 0; k < INTERNAL.FILL_BISECT; k++) { const mid = (lo + hi) / 2; if (hits(at(mid), i)) hi = mid; else lo = mid; }
    T[i] = at(lo);
  }
  return T;
}

/* --------------------------------------------------------------------------
   9. PUBLIC API
   -------------------------------------------------------------------------- */
function settings(algorithm, overrides) {
  if (!ALGORITHMS[algorithm]) throw new Error("Unknown spread algorithm: " + algorithm);
  const S = { ...DEFAULTS.common, ...DEFAULTS.scoring, ...DEFAULTS[algorithm] };
  if (algorithm === "anneal") {
    const n = DEFAULTS.natural;
    S.pushStart = { iterations: n.iterations, step: n.step, aspect: n.aspect, polish: n.polish };
    S.rowsStart = { rows: DEFAULTS.rows.rows };
  }
  return { ...S, ...(overrides || {}) };
}

// The full pipeline: algorithm, placement toward the real windows, polish, optimizer
// safeguard, gap filling, score, centering (when asked for).
// info (diagnostics, present when relevant):
//   natural:  iterations, hitLimit
//   anneal:   starts, winningStart (1-based), winningKind, startsPerRound, acceptRate,
//             keptStart (null, or the starting layout kept by the safeguard)
//   polish:   polishMoves, polishGain
function compute(windows, monitor, algorithm, S) {
  const algo = ALGORITHMS[algorithm];
  if (!algo) throw new Error("Unknown spread algorithm: " + algorithm);
  S = S || settings(algorithm);
  if (algorithm === "anneal" && (!S.pushStart || !S.rowsStart)) S = settings(algorithm, S); // fill in start settings
  const ws = windows.map(w => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h }));
  const A = workArea(monitor, S.margin), info = {};
  // Input nothing can be laid out from (and that could make the algorithms misbehave)
  if (![A.x, A.y, A.w, A.h].every(Number.isFinite) || !(A.w > 0) || !(A.h > 0))
    throw new Error("no usable area: monitor " + JSON.stringify(monitor) + ", margin " + S.margin);
  for (const w of ws) {
    if (![w.id, w.x, w.y, w.w, w.h].every(Number.isFinite) || !(w.w > 0) || !(w.h > 0))
      throw new Error("unusable window frame: " + JSON.stringify(w));
  }
  if (!ws.length) return { targets: [], score: null, info };
  const shared = {}; // what the optimizer hands on to its safeguard
  let T = algo.run(ws, S, A, info, shared);
  if (algo.uniformScale && !S.centered) T = placeNearReal(T, ws, A);
  if (algo.polishable && S.polish) {
    const r = polishLayout(T, ws, S, A);
    T = r.T; info.polishMoves = r.moved; info.polishGain = r.gain;
  }
  if (algorithm === "anneal") T = optimizerSafeguard(T, ws, S, A, info, shared);
  if (algo.uniformScale && S.fill) T = fillGaps(T, S, A);
  // Scored before centering: the user asked for that move, so it costs nothing.
  const sc = scoreLayout(T, ws, S, A);
  if (algo.uniformScale && S.centered) T = centerLayout(T, A);
  return {
    targets: T.map(t => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h, scale: t.w / t.ow })),
    score: sc,
    info,
  };
}

function score(targets, windows, monitor, S) {
  if (!targets.length) return null;
  return scoreLayout(targets, windows, S, workArea(monitor, S.margin));
}

// Canonical text for any value: object keys sorted, so the order things were built in never
// matters. Used for cache keys.
function stableText(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableText).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stableText(v[k])).join(",") + "}";
}
// Everything a layout depends on, as one string. Windows are sorted by id (never taken in the
// given order, which may follow stacking); settings are limited to the keys the engine uses.
function cacheKey(windows, monitor, algorithm, S) {
  const ws = windows.map(w => [String(w.id), w.x, w.y, w.w, w.h])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const used = {};
  for (const k of Object.keys(settings(algorithm))) used[k] = S[k];
  return stableText([algorithm, [monitor.x, monitor.y, monitor.w, monitor.h], ws, used]);
}
function copyResult(r, cached) {
  return { targets: r.targets.map(t => ({ ...t })), score: r.score && { ...r.score }, info: { ...r.info }, cached };
}
function createCache() {
  const slots = new Map(); // slot -> { key, result }
  return {
    compute(windows, monitor, algorithm, S, slot = "default") {
      if (!ALGORITHMS[algorithm]) throw new Error("Unknown spread algorithm: " + algorithm);
      S = S ? settings(algorithm, S) : settings(algorithm); // fill in anything not given, as compute() does
      const key = cacheKey(windows, monitor, algorithm, S), entry = slots.get(slot);
      if (entry && entry.key === key) return copyResult(entry.result, true);
      const result = compute(windows, monitor, algorithm, S);
      slots.set(slot, { key, result: copyResult(result, false) });
      return copyResult(result, false);
    },
    forget(slot) { slots.delete(slot); },
    clear() { slots.clear(); },
  };
}

const deepFreeze = o => { Object.values(o).forEach(v => typeof v === "object" && v && deepFreeze(v)); return Object.freeze(o); };
return Object.freeze({
  DEFAULTS: deepFreeze(DEFAULTS),
  ALGORITHMS: Object.freeze(Object.keys(ALGORITHMS)),
  settings, compute, createCache, score, random,
});
}
var SpreadLayout = createSpreadLayout();
if (typeof module !== "undefined" && module.exports) module.exports = SpreadLayout; // Cinnamon require() and Node
