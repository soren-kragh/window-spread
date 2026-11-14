# Window Spread: development notes

For whoever continues this project, human or AI. `README.md` explains how to
install and use the extension; this file explains how it works, why it is the
way it is, what has been verified and how, and what is still open. Read it
before changing anything: several "obvious improvements" were tried and are
recorded below as rejected, with the evidence.


## 1. Goal

Replace the window arrangement of Cinnamon's **Show all windows** view (Scale),
and of the windows inside each workspace in **Show all workspaces** (Expo), with
one that keeps thumbnails near where the windows really are, keeps their
relative sizes, and **never depends on stacking order or focus history**. That
last point is the original motivation: Cinnamon's own Scale view fills a grid in
stacking order, so the arrangement changes whenever a different window was
focused. Status: working on the target system (Linux Mint 21.3, Cinnamon 6.0.5,
one 2560×1440 monitor), and tested against the source of Cinnamon 6.0.5, 6.2.10,
6.4.14, 6.6.9 and 6.8.0 (section 6.1).


## 2. Files and the rules that keep them consistent

```
README.md                         installation and use
DEVELOPMENT.md                    this file
lab/window-spread-lab.html        browser lab: simulated desktop, tuner
extension/window-spread@soren-kragh/
  spreadLayout.js                 THE layout engine; the only copy
  extension.js                    Cinnamon glue: patches Scale and Expo
  settings-schema.json            settings dialog definition (generated)
  metadata.json                   extension metadata
  icon.png, LICENSE               icon (from docs/icon.svg), license copy
docs/                             icon source, screenshot
tools/build-schema.js             generates settings-schema.json
tools/build-spices.js             builds the Spices package (section 9)
tools/spices/                     Spices' README and info.json
tests/                            automated checks (section 7)
```

Rules (each one fixed a real problem):

* **One engine.** `spreadLayout.js` exists once. The extension loads it through
  `Extension.getCurrentExtension().imports.spreadLayout` on Cinnamon 6.8+, or
  `require('./spreadLayout')` on 6.0-6.6 (section 6.1); the lab loads it with
  `<script src="../extension/window-spread@soren-kragh/spreadLayout.js">`; the
  lab's tuner threads rebuild it from `createSpreadLayout.toString()`. Never
  paste engine code anywhere else. Consequence: the lab only works from inside
  this folder.
* **Defaults live in the engine.** `DEFAULTS` (section 1 of `spreadLayout.js`)
  is the only place the layout defaults are defined. The lab reads them from
  there. Settings that exist only in the settings dialog (each view's
  algorithm, Show all workspaces' margin and gap, the Enable switches, layout
  caching and diagnostics) have their defaults in `tools/build-schema.js`.
  `settings-schema.json` needs its own copy for Cinnamon's dialog, so it is
  generated: after changing a default, run `node tools/build-schema.js`. A
  test fails if the two differ.
* **The engine knows nothing about the DOM, Cinnamon, or stacking.** Its input
  is window frames `{id, x, y, w, h}` and a monitor rectangle; any other fields
  are ignored.
* **The engine is stateless and deterministic.** Remembering (the cache) is a
  separate, optional helper, `SpreadLayout.createCache()`.
* **JavaScript features:** the engine and extension use arrow functions, spread,
  `Map`, typed arrays: nothing newer than roughly ES2018, all supported by
  Cinnamon 6.0's JavaScript engine. The tests avoid optional chaining (`?.`) and
  `??` so they run on Mint 21.3's packaged Node 12.


## 3. Architecture

### Engine (`spreadLayout.js`)

Public API: `DEFAULTS`, `ALGORITHMS`, `settings(algorithm, overrides)`,
`compute(windows, monitor, algorithm, settings)`, `createCache()`, `score(...)`,
`random(seed)`; documented at the top of the file.

`compute()` pipeline:

1. **Algorithm**, one of
   * `optimizer`: gradient descent over window centers, in "layout units"
     (true relative sizes, one shared scale), on a smoothed copy of the score.
     The overlap penalty starts weak and grows, so the arrangement can contract
     through overlaps before it is pushed apart. One start from each starting
     layout (5.6); the starts race (5.3). Details and evidence: 5.20.
   * `push`: push apart (overlapping windows pushed apart, then scaled).
   * `rows`: ordered rows.
   * `grid`: equal grid. Each window goes in its nearest cell: the assignment
     with the smallest total distance between windows and cells, computed
     exactly with the Hungarian method (`assignOptimal`, 5.15). Scales windows
     unevenly.
2. **Placement:** unless `centered`, the arrangement is moved as a whole toward
   the real windows, as far as the work area allows (5.2).
3. **Polish** (optimizer, push): greedy small moves into free space that
   lower the score (5.2; how it is kept cheap: 5.18).
4. **Safeguard** (optimizer): the push-apart and ordered-rows layouts, with
   those algorithms' settings, are finished the same way (whether or not the
   search started from them), and the best-scoring layout wins (5.7). It reuses
   those layouts from the search where it built them, and skips polishing a
   candidate that provably can't win (5.18).
5. **Fill gaps** (optional): thumbnails grow into free space.
6. **Score.**
7. **Center** (if `centered`): the arrangement is moved as a whole to the
   middle of the work area. It comes last because the polish, the safeguard's
   polished candidates and the gap filling all move thumbnails toward the real
   windows or unevenly, which would undo an earlier centering. It comes after
   the score because the user asked for this move, so it shouldn't count as a
   worse fit.

**Score** (lower is better; the same function drives the optimizer, the polish,
and all comparisons): `wSize × size + wSizes × distortion + wPlace × movement +
wRelations × relations` (+ an overlap term that only matters during the
search). Size is the mean of −ln(scale) after removing the intended
size-fidelity factor; a thumbnail held at the max scale counts as large as the
largest one that isn't (5.4).
Distortion is the mean absolute deviation of log scales (0 for one shared
scale). Movement is the mean distance from real centers, relative to the screen
diagonal. Relations come in two methods: "order" (left/right, above/below flips,
weighted by orientation: 5.8) and "direction" (change of angle between window
pairs, with neighbor focus). Internal constants are in `INTERNAL` (section 2 of
the file), with comments.

### Extension (`extension.js`)

While enabled, it replaces two methods of Cinnamon's `WorkspaceMonitor` (6.0.5,
`js/ui/workspace.js`):

* `_computeAllWindowSlots(n)`: calls the engine (through the cache, one slot per
  monitor and workspace) and returns, per window, a slot exactly the size of its
  thumbnail plus Cinnamon's decorations, in Cinnamon's slot format `[xCenter,
  yCenter, xFraction, yFraction]`. Cinnamon's own `_computeWindowLayout` then
  fits each window into its slot, which puts the thumbnail exactly where the
  engine said; animations, titles and clicks stay Cinnamon's.
* `selectAnotherWindow(symbol)`: arrow keys move to the nearest thumbnail in
  that direction (Cinnamon's version assumes its grid). Other keys use the
  original.

Both fall back to Cinnamon's original on any error, so the view never breaks,
and both use the original while the `scale-enabled` switch is off. Keyboard
navigation checks the switch itself too: switched off while the view is open,
the clones still carry positions from the extension's earlier layout (a test
covers this case). Details:

* **Decorations:** the close button overhangs above and at the sides, the title
  sits below (`WindowOverlay.chromeHeights/chromeWidths`). The engine gets the
  monitor shrunk by the decorations, the user's gap, and the decorations as
  extra gaps: `extraGapX` = left + right between thumbnails side by side,
  `extraGapY` = top + bottom one above the other (section 5.22).
* **Title width:** Cinnamon limits every title to one shared width
  (`_slotWidth`), centered under each thumbnail; the extension sets it to the
  smallest thumbnail width plus the gap side by side, so no title can reach a
  neighbor, but adds at most twice the room at the screen's edges (margin +
  decorations), so with a gap over twice the margin no title reaches past them.
* **Margin:** Cinnamon's own 1% margin is replaced by the extension's margin
  setting.
* **Max scale:** Cinnamon caps thumbnails at scale 1, so the setting's maximum
  is 1.
* **Window identity:** `metaWindow.get_stable_sequence()`, which Cinnamon itself
  uses.
* **Keyboard navigation** keeps each thumbnail's center in the extension's own
  `WeakMap` (keyed by Cinnamon's window clone), not as a property on Cinnamon's
  objects, which are GObject-based classes from 6.8 on.
* **Minimized windows** are passed with their normal frame like any other
  window.
* **Settings** are read on every layout (cheap); the cache key includes them, so
  changes take effect at the next opening. Resetting them is left to the
  dialog's own menu item, **Reset to defaults**: an extension button calling
  `setValue` for every key wrote the settings file once per key, which raced
  with the dialog's own file watching and saving, so some settings stayed
  unreset.
* **Unusable results:** the engine's targets are checked (one per window,
  finite, sizes above 0) before Cinnamon gets them; anything else, like an
  error, falls back to Cinnamon's own layout, and keyboard navigation then
  follows Cinnamon's grid too. Expo computes and checks the layouts of all
  monitors before it moves anything.
* **Lifecycle:** `enable()` reads the settings before it patches anything, and
  each replacement keeps its own reference to Cinnamon's original, so a call
  after `disable()` still reaches Cinnamon's code. A second `enable()` without
  `disable()` first disables.
* **Diagnostics** (setting "Write diagnostics to the log"): one line per
  workspace per opening (indexes, visible workspace name, counts, algorithm,
  cache use, time, score), minimized window frames, and the decoration sizes
  once per session.

**Show all workspaces (Expo).** Each workspace thumbnail is an
`ExpoWorkspaceThumbnail`; its `overviewModeOn()` arranges that workspace's
windows (on hover, on window changes, or for all thumbnails at once). Unlike
Scale, Cinnamon writes the grid calculation inline in that method, so there is
no smaller method to replace: the extension replaces the whole method with
`expoOverviewModeOn()`, which performs the same steps as Cinnamon's (hide
windows that don't belong, refresh clones with transients, show urgency, size
and place app icons, animate with the same timing and completion callbacks) with
positions from the engine. Rejected alternative: letting Cinnamon's method run
and re-animating afterwards, because re-animating cancels Cinnamon's animations,
whose completion callbacks are what make windows and icons visible again.
* One engine call per monitor over the monitor's full area, as Cinnamon does; a
  window being dragged keeps its place in the layout but isn't moved (as in
  Cinnamon).
* The engine lays out visible frames; Expo positions window *actors*, which
  include invisible borders. Conversion: `scale = target.w / frame.w`, `actor.x
  = target.x − (frame.x − actor.x0) × scale` (same for y).
* App icon badges: scale `0.25 / boxScale / scale`, so every badge is 32 px on
  screen, as in Cinnamon. Cinnamon anchors the badge to the window *actor's*
  corner (`ICON_OFFSET` = −5 screen px beyond it); the extension anchors it to
  the *visible frame's* corner at the same offset, and reserves the overhang (5
  / boxScale full-size px) in the margin (left, top) and the gap (the same in
  both directions), like the Scale view's decorations (5.16). The constants
  (100 ms, −5, 0.25) are module-level in Cinnamon and not exported, so they're
  repeated in `extension.js`; a test compares them with each Cinnamon version's
  source.
* Version differences, detected at runtime: 6.0-6.6 keep the clone actor in
  `window.actor` and the thumbnail scale in `box.scale`; 6.8 makes the clone the
  actor and renames the scale `box.thumbnail_scale`. The arrangement logic is
  otherwise identical in 6.0.5 to 6.8.0; a test fingerprints Cinnamon's method
  so a future change is flagged rather than silently overridden.
* Own settings: `expo-enabled`, `expo-algorithm` (default optimizer),
  `expo-margin` and `expo-gap` (default 14 px, as Cinnamon; room for the
  badges is added automatically), and its own copies of size fidelity, max
  scale, centering, gap filling and max growth (`EXPO_SETTINGS_MAP`, same engine
  defaults as Show all windows). Only the scoring weights and the algorithms'
  own settings are shared. Each view has an Enable switch (`scale-enabled`,
  `expo-enabled`); with both off, behavior equals Cinnamon's original exactly
  (tested: slots, title width, every arrow key, Expo positions, badges and
  visibility). On both view tabs, settings the equal grid doesn't use are hidden
  while it is selected (`dependency: "algorithm!=grid"`, and
  `"expo-algorithm!=grid"` on the Show all workspaces tab). Switched off,
  Cinnamon's original runs. Errors fall back to the original. Cache slots
  `expo/<monitor>/<workspace>`, separate from Scale's.

### Lab (`lab/window-spread-lab.html`)

Simulated 1920×1080 desktop, the four algorithms with all settings, comparison
view, measurements, layout cache and minimize simulation, and a multi-threaded
tuner for the optimizer's settings (Web Workers running the engine rebuilt from
its factory; falls back to time-slicing on the page). Help texts for every
control are in the `INFO` object and the `*_UI` tables (section L2/L3 of the lab
script). The lab's default settings come from the engine.


## 4. Guarantees (covered by tests, at defaults and at the ends of the ranges)

The optimizer is tested at reduced effort to keep the tests fast; its effort
only changes how far the search gets, not what the guarantees rely on (the
cleanup, gap enforcement and safeguard run the same at any effort).

* No stacking order, focus, or minimized state is ever used; input order doesn't
  matter.
* Deterministic: same input and settings, same output; moving the monitor and
  its windows together by whole pixels (e.g. a second monitor) moves the layout
  along, exactly.
* No overlaps; everything inside the monitor minus `margin` (to 0.5 px); scale
  at most `maxScale`; finite positions and sizes above 0.
* Gaps at least `gap`, plus `extraGapX` side by side or `extraGapY` one above
  the other, unless the gaps are too large for the screen and the number of
  windows (tested up to an effective gap of 58 px, more than the default gap
  plus decorations). With very large gaps (e.g. 130 px, 12 or more windows on a
  1366×768 screen) push apart's overlap removal stops short and gaps can be
  smaller; the equal grid shrinks its gaps when they would leave no room for
  the cells; ordered rows with a fixed row count that doesn't fit uses the best
  row count instead. Widening the padding until the real gap is right (5.5) may
  take up to 100 rounds (`GAP_ROUNDS`); with 8, crowded desktops (20-30 windows,
  e.g. on a 1052×1870 portrait monitor) ended up to 0.7% short of the gap. The
  extra rounds only run where needed and cost no measurable time.
* Push apart, ordered rows and the optimizer use one shared scale (exact
  relative sizes at fidelity 1).
* The optimizer never scores worse than push apart or ordered rows given the
  same settings (`pushStart`, `rowsStart`), whatever it starts from, as long as
  gap filling is off.
* Input that can't be laid out (a non-finite number, a window or work area of
  size 0) is an error, not an unusable layout.


## 5. Design decisions and the evidence behind them

Scores below come from different stages of the project, with different scoring
rules and weights; compare numbers only within one table.

### 5.1 Geometry-only processing order
Windows are sorted by center y, center x, width, height, then id before anything
else. This makes every algorithm independent of input order, and so of stacking.

### 5.2 Placement toward real windows, and the polish
Problem seen: a thumbnail obviously could move closer to its window into free
space, but didn't. Two causes: (a) forced centering made an edge window a
"counterweight" for the others; (b) the search, then simulated annealing (5.20),
made small final gains below its noise for most of the run, leaving slack.
Fixes: placement toward the real windows (instead of centering), and a greedy
polish. Count of layouts (80 tested, 12 windows) where some window could move
60 px toward home into free space:

| | old | new |
|---|---|---|
| relations weight off | 24 | 1 |
| relations weight on | 62 | 47 (the rest are genuine relation trade-offs) |

### 5.3 Parallel starts racing (successive halving)
Single searches varied a lot with the seed (average scale 0.42 to 0.53 over 20
seeds). Starts now run in lockstep; at checkpoints the worse half is dropped.
The checkpoint position matters: too early, the search is still hot and scores
mean little. 6 desktops × 20 seeds, equal total effort:

| setup | mean | worst | seed spread |
|---|---|---|---|
| 1 start | 0.9246 | 0.9898 | 0.1165 |
| 4 starts, equal shares | 0.9193 | 0.9737 | 0.0829 |
| 4 starts, checkpoint 0.2 | 0.9110 | 0.9669 | 0.0922 |
| 4 starts, checkpoint 0.5 | 0.9095 | 0.9576 | 0.0817 |
| 4 starts, checkpoint 0.7 | 0.9184 | 0.9810 | 0.1003 |

The number of starts is broadly flat between 2 and 8 (within about 1%); 12 or
more spread the effort too thin. These measurements are of the simulated
annealing search the optimizer used before 5.20. With gradient descent the
search no longer depends on luck. On the 294 desktops of 5.20, 4 starts (one
per starting layout) racing with checkpoint 0.2 are as good as running all four
to the end at the default 1000 steps (desktops more than 10% from the best: 7
and 5; mean gap 1.38% and 1.40%), and clearly better at 500 steps (6 and 12;
1.69% and 2.56%), so the race stays for users who lower the effort. 3 starts
are a little worse (6, 1.61%), 8 a little better (4, 1.30%) for the same time.
The race's settings are fixed (not in the extension's settings window); the
lab keeps them.

### 5.4 Size distortion term
The equal grid used to beat the optimizer on some desktops (2 found where it won
on all 6 seeds) purely through the size term: it enlarged small windows more
than big ones (size spread 1.7 to 2.0), which raised the average scale. Since
uneven scaling was one of the original complaints, the score now charges for it
("Keep sizes"). After the change: 0 such desktops.

Uniform-scale algorithms are never charged. With few windows, thumbnails reach
the max scale and stop growing; with size fidelity below 1, small windows get
there first, so their sizes no longer follow size fidelity. The score used to
charge that, in both the size and the distortion terms, which rewarded
shrinking the larger windows below the limit so that the ratios matched again:
smaller thumbnails, scored as better. A window that could be shown at the max
scale isn't a fault, so a thumbnail held at the max scale now counts as large
as the largest one that isn't (as the max scale if all are). The optimizer's
search, which never saw capping, now scores uniform layouts exactly as the
score does. Measured on 300 desktops of 2 to 8 windows (typical and small
sizes, 2560×1440), the equal grid still beats the optimizer on none, at max
scale 1 and 0.9; the optimizer's layout changed on 45 (34 at max scale 0.9),
always to bigger thumbnails in total, and never with fewer windows at the max
scale.

The max scale defaults to 0.9: at 1, a single window, or a few that already
fit, look exactly as on the desktop, so opening the view seems to do nothing.

Keep sizes is **not offered in the extension's settings** (it stays at the
engine default): it only charges the equal grid and gap filling, which don't
search by the score, so it never changes a layout there. In the lab, the slider
stays: it keeps comparisons with the equal grid fair.

### 5.5 Exact gaps, no outer half-gap
Push apart and the optimizer used to guess the gap before knowing the final
scale (actual smallest gaps 18.2 and 20.8 px for a 24 px setting) and also
reserved half a gap around the outside. Now they widen the padding until the
real gap is right, and scale by the windows' extent. Result: smallest gap
exactly 24.00 px, and *bigger* thumbnails (average scale: push apart
0.401 → 0.407, optimizer 0.460 → 0.490).

### 5.6 Starting points
The optimizer can start from push apart, ordered rows, equal grid, the real
positions, or "mixed" (one kind per parallel start). Average over three sets of
8 desktops: push 0.6139, rows 0.6104, grid 0.6127, real positions 0.6193, mixed
0.6103. No single start wins everywhere; mixed is never far from the best. Rows
and grid starts undo their layout's scale and resolve overlaps (true-size
windows can be too big for grid cells).

### 5.7 Optimizer safeguard, and starts with the algorithms' own settings
Despite starting from them, the optimizer sometimes lost: to rows in 8 of 120
runs (by at most 0.4%, because the rows start is a converted layout), and to
push apart in 2 of 180 (by up to 4.7%, because its push start used different
push settings than the push-apart algorithm). Fixes: the safeguard (best of the
finished starting layouts and the search result), and `pushStart`/`rowsStart`
settings so "start from push apart" means exactly the push-apart algorithm as
configured. After: 0 losses in 288 runs over 36 setting combinations. Effect on
the optimizer's own quality was neutral (0.6501 → 0.6498 with the default start;
mixed 0.6425 → 0.6448).

### 5.8 Order relations weighted by orientation
Case from the target system: a window near the right edge stayed 90 px above its
home although the space below was free. Cause: a window on the far left was 32
px lower, so the Order method treated the pair as "above/below" and penalized
moving down past it. Now a pair's left/right relation counts by cos² of the
angle between the windows, its above/below relation by sin². On that desktop the
window moved to 1 px from home and the average distance of all windows from home
went from 136 to 125 px at the same scale. Ordered rows benefited noticeably
(Workday scenario 0.632 → 0.541).

### 5.9 Rejected: leveling off the Direction penalty
Case: with neighbor focus 0.7, a window was held in place by the angles to its
two nearest neighbors, whose thumbnails were themselves displaced. Idea: cap the
penalty for already-broken relations (`c · (1 − e^(−x/c))`). Measured, it made
things worse: it weakens the relations term overall, and with thumbnail size
weighted at 4 the optimizer packs tighter instead. "Home" is that window's
distance from home; the other columns are averages over random desktops:

| level c | home | scale | movement | direction change |
|---|---|---|---|---|
| unchanged | 153 px | 0.641 | 244 px | 14.6° |
| 0.15 | 170 px | 0.666 | 257 px | 20.2° |
| 0.08 | 215 px | 0.676 | 252 px | 22.8° |
| 0.02 | 234 px | 0.681 | 257 px | 25.4° |

Conclusion: it was a weights question. The user then lowered neighbor focus to
0.5 and keep relations to 1, and raised stay in place to 2 (current defaults).

### 5.10 Aimed moves (removed)
The simulated annealing search (before 5.20) let a share of its random moves
jump part of the way toward the window's "home" instead of a random direction;
on crowded desktops it gave the same quality with 2-4× fewer moves. Gradient
descent has no random moves, so it went with the annealing.

### 5.11 Performance
One descent step moves every window and checks every pair, so a step costs
about n² pair operations. Default effort is 1000 steps shared by the starts
(the old default of 10k annealing moves was the same order of work at 10
windows). Time per layout, quality and effort: 5.20. The cache makes
recomputation rare (5.12).

### 5.12 Cache
Last layout per slot (monitor and workspace), exact match on window ids and
frames, monitor, algorithm and the engine settings in use. The key is built in
canonical order (windows sorted by id), so stacking and focus changes reuse it.
Considered and decided against (for now): deferring other workspaces and
pre-warming the cache in the background; the cache already makes reopening
practically free.

### 5.13 Settings window on pages
Mint's slider widget (python3-xapp `SettingsWidgets.Range`) installs its own
scroll handler that changes the value and swallows the event, so scrolling the
window over a slider changes it. This can't be switched off from the schema.
Fix: short pages (five now, at most 9 settings each, and settings that don't
apply are hidden with `dependency`). The dialog allows only one condition per
setting, but sections can have their own: each view tab therefore has its Enable
switch in one section and everything else in a section hidden while the switch
is off, and settings inside keep their own conditions (equal grid, fill gaps).
Supported in the dialog of Cinnamon 6.0.5 to 6.8.0 (`add_reveal_section`).
Remaining corner case: max growth follows fill gaps only, so it stays visible if
fill gaps is on and the equal grid is then chosen.
(Custom widgets were considered: more code, more fragile.)

### 5.14 No spin button with the value 0
Cinnamon's settings dialog only passes a value to a widget if it differs from
the widget's current value (`set_object_value()` in `JsonSettingsWidgets.py`). A
new GTK spin button already holds 0, so a spin button whose setting is 0 is
never updated and shows no number at all (the value itself is correct). Hence
"Number of rows", where 0 means automatic, is a drop-down (Automatic, 1 row, ...
8 rows); drop-downs are set through a listener and don't have this problem.
Margins and gaps are sliders (0-200 px, steps of 2), which show 0 correctly
(checked on 6.0.5). A test fails if a spin button can be set to 0.

### 5.15 Equal grid: nearest cell (Hungarian method)
The grid used to fill cells in reading order of window position (rows by height,
then left to right). That's independent of stacking, but rows are filled by
count, so a window could land in a row far from its height. Now each window goes
in its nearest cell: the assignment of windows to cells with the smallest total
distance (center to center), solved exactly by the Hungarian method in O(n³),
about 0.3 ms for 20 windows. Measured average distance from home, 20 random
desktops per size: 4 windows 395 → 361 px, 9 windows 354 → 303 px, 20 windows
326 → 290 px (7-14% less). Verified optimal against brute force. The
reading-order variant was removed rather than kept as an option: the
nearest-cell assignment is never worse in total, and an option nobody needs is
noise (user's decision). Side effect: the optimizer's "grid" start improved, and
with the default Mixed start its average score went from 2.6126 to 2.5890
(better in 27, worse in 9 of 120 runs).

### 5.16 Expo badges anchored to the visible window
Symptom on the target system: app icon badges collided with neighboring windows
in Show all workspaces, though never in Cinnamon's own Expo. A first "fix"
raised the Expo margin and gap to 32 px, with the claim that badges need the
room. That was wrong: Cinnamon's grid uses 14 px without collisions. The real
cause: the badge is a child of the window actor, positioned relative to the
actor's corner, and the actor includes invisible borders (resize borders, and
wide shadows on windows that draw their own, such as GTK apps). Cinnamon spaces
actors, so a badge stays in its own window's invisible border area. The
extension spaces the visible frames, so a badge anchored at the actor's corner
ended up far outside the visible window, in the gap or over a neighbor. Fix:
anchor the badge to the visible frame's corner and reserve its 5-screen-pixel
overhang in margin and gap; defaults back to 14 px. The tests now use windows
with no, typical (10 px) and wide uneven (shadow) invisible borders, and check
badge placement and clearance directly; against the previous code they fail (5
checks, including a badge touching another window). Lesson: test windows with
uniform 10 px borders hid the problem; simulate realistic variety.

### 5.17 Wording
Tooltips in the settings window describe what a setting does, in terms a user
can see; how it is implemented (decorations, badge overhang, coordinate systems,
Cinnamon internals) belongs in the code comments and in this file (user's
decision).

The equal grid is not named "Cinnamon-like": it resembles Cinnamon's grid but,
unlike it, never depends on stacking. Its descriptions (README, tooltip) do
compare it with Cinnamon's grid, always stating that difference (user's
decision). The optimizer is not labeled "recommended" (user's choice).

The algorithm drop-down's tooltip has one short paragraph per choice, not
bullets: Cinnamon's dialog sets plain-text tooltips, which GTK wraps at 70
characters without indenting the continuation lines, so wrapped bullets look
ragged. Cinnamon's dialog has no tooltips per choice.

### 5.18 Polish: same result, a fraction of the work
Profiled (Node after warm-up, 2560×1440, random desktops, optimizer at 10k
moves): from about 12 windows up, the polish cost more than the search. At 30
windows the optimizer's three polishes (its result, and the push-apart and
ordered-rows candidates in the safeguard) took 64% of its 40 ms, and push apart
was 95% polish. Each pass tried 64 moves per thumbnail and rescored every one
against all other thumbnails, recomputing the unchanged "before" value each
time.

Changes, all exact (identical layouts, scores and diagnostics, bit for bit):

* Polish: the "before" value is computed once per position; only neighbors
  within reach of the step are checked for gap and overlap; the overlap terms
  are skipped while nothing overlaps (they are exactly 0); a thumbnail whose
  scan found nothing is not scanned again until something else moves.
* Direction relations are kept as row-wise typed arrays with one formula
  (`dirPen`), read directly by the polish and by the search.
* Safeguard: it reuses the push-apart and ordered-rows layouts the search built
  as starting points, and skips a candidate's polish when a lower bound on its
  polished score (`polishLowerBound`: the size terms, which polishing can't
  change, plus the movement forced by pairs that would be too close at their
  real positions) can't beat the best.

Evidence: compared with the previous engine on 5842 results (all algorithms;
0-45 windows; random, oversized, tiny, stacked and grid-aligned desktops; three
monitor shapes; 19 setting sets and 17 optimizer variants, including leftover
overlaps and the order method): no difference. Every new code path was taken
(overlap path, bound skips, reused layouts). Time in ms, old → new:

| windows | 4 | 8 | 12 | 20 | 30 |
|---|---|---|---|---|---|
| optimizer | 4.1 → 3.7 | 7.4 → 5.8 | 8.0 → 4.9 | 17.3 → 8.3 | 34.3 → 14.6 |
| push apart | 0.13 → 0.05 | 0.47 → 0.13 | 1.37 → 0.33 | 4.2 → 0.9 | 6.8 → 1.6 |

The search (then simulated annealing, 5.20) was then about 70% of the
optimizer's time at 30 windows.
Confirmed in Cinnamon on the target system (section 6.2): the same scores as the
previous engine for the same windows, and faster.

What the polish gains (share of the score before it): the search result
0.3-3%, push apart 3-9%; the safeguard's polished candidates win on about half
of all desktops at 4 windows, almost never at 8-20, and occasionally at 30
(rows). So the polish is worth keeping; it was just done expensively.

Rejected (measured in two independent studies): heuristics that skip
directions going uphill, stop on small gains, cap the passes, or skip
candidates by a margin. They would make the polish another 1.5-2× faster but
change results now and then (push apart up to 8% worse on single desktops); not
worth it after the exact changes (user's decision).

### 5.19 No time budget; the user sets the effort
Considered: limiting the optimizer's time. A wall-clock stop would break
determinism and cut the search's schedule short. Setting the effort from the
window count instead would work (a step's cost grows with the number of
windows). Rejected (user's decision): the user knows their PC and how many
windows they typically have, and sets the effort. The settings window shows it
as a plain number from 1 to 100 (`optimizer-effort`, default 10; the extension
multiplies by 100 descent steps, the unit in its SETTINGS_MAP), and its tooltip
says to lower it if opening the views gets choppy.

### 5.20 Optimizer: gradient descent instead of simulated annealing
The optimizer used to be simulated annealing: random moves of one window at a
time, worse moves accepted early on. Measured against the best layout any
method found for each desktop, it was often far off on crowded desktops: from
12 windows up, most desktops ended 10-20% worse, and 5× the effort helped
little. Cause: in a tight arrangement, it can only shrink (bigger thumbnails)
if many windows move together; every single-window move toward that runs into
a neighbor and is rejected.

Now: gradient descent (Adam) on all windows at once, on a smoothed copy of the
score (the box's sides and the size term's corner at the max scale are rounded
so the descent can follow them). The overlap penalty starts at 3 and grows to
300 over the schedule, so the arrangement first contracts through overlaps and
then separates (as in analytical chip placement); the step size shrinks from
`firstStep` (0.3 of the average window size) to 0.0002. One start per starting
layout (push apart, ordered rows, equal grid, real positions), racing (5.3);
then the unchanged cleanup, gap enforcement, polish and safeguard. Nothing is
random with "mixed" starts and up to four of them (the default), so the result
doesn't depend on the seed.

Evidence: 294 desktops of 3-30 windows (random sizes on 2560×1440, mixed sizes
on 1920×1080, small windows on 2560×1440); the old optimizer at 5k and 10k moves
with 3 seeds and at 50k with one, the new one at the equivalent 500, 1000 and
5000 steps. Gap = how much worse than
the best score any run found for that desktop (worst seed for the old one);
median time in Node on a server:

| windows | old 10k: >10% / mean gap / ms | new 1000 steps | new 500 steps |
|---|---|---|---|
| 3 | 0 / 0.2% / 2.2 | 0 / 0.1% / 0.6 | 0 / 0.1% / 0.4 |
| 5 | 2 / 1.8% / 2.8 | 0 / 1.3% / 0.9 | 0 / 1.3% / 0.5 |
| 8 | 9 / 6.5% / 3.7 | 3 / 2.2% / 1.4 | 2 / 1.8% / 0.9 |
| 12 | 15 / 8.9% / 5.0 | 1 / 1.3% / 2.4 | 1 / 1.7% / 1.5 |
| 16 | 32 / 18.2% / 6.4 | 0 / 1.0% / 3.5 | 0 / 1.7% / 2.2 |
| 21 | 38 / 20.7% / 8.1 | 1 / 1.5% / 5.0 | 2 / 2.5% / 2.9 |
| 30 | 32 / 17.5% / 11.7 | 0 / 1.3% / 9.2 | 0 / 1.8% / 5.7 |
| all 294 | 128 / 10.5% | 5 / 1.3% | 5 / 1.6% |

(">10%": desktops more than 10% worse than the best; 42 per row.) The old
optimizer at 50k moves still had 63 desktops more than 10% off. With few
windows nothing changes; from 12 windows up the new one finds bigger
thumbnails, with better relations and a little more movement (40 random
desktops per row, default settings; size / movement / relations parts of the
score, and the share of the screen the thumbnails cover):

| windows | old | new |
|---|---|---|
| 3 | 0.43 / 0.23 / 0.03, 36% | 0.44 / 0.22 / 0.03, 36% |
| 8 | 1.24 / 0.41 / 0.20, 67% | 1.25 / 0.41 / 0.19, 67% |
| 12 | 2.16 / 0.40 / 0.25, 67% | 2.00 / 0.42 / 0.23, 73% |
| 21 | 3.52 / 0.37 / 0.27, 62% | 3.12 / 0.42 / 0.20, 75% |
| 30 | 4.34 / 0.36 / 0.29, 60% | 3.87 / 0.41 / 0.20, 76% |

Default effort: 1000 steps. 500 takes 0.6 of the time with a mean gap of 1.6%
instead of 1.3%, the difference being from 12 windows up. The push-apart,
ordered-rows and
equal-grid layouts are unchanged (identical on all 294 desktops).

Also tried (two independent studies), not adopted: tuning the annealing
(temperature, starts, cooling, move size, aimed moves) and other move kinds
(swaps, one axis, jumps next to a neighbor): no gain or worse. Gradient
refinement after the annealing: 2-3% better, far less than replacing it.
Annealing followed by a relocation search (each window in turn moved to where
the compacted arrangement is smallest): clearly better than annealing alone,
but behind gradient descent from 12 windows up, and much more code. A size term
that charged thumbnails held at the max scale for uneven sizes, with extra steps
to steer the descent back below the limit: made obsolete by 5.4.

Settings: only the effort remains in the extension's settings window. Starts,
first checkpoint, first step size (was temperature), start from, seed,
dropping weak starts and polish are fixed; the lab keeps them. Without polish,
the mean gap was 3.3% instead of 1.4% (3.2% instead of 0.7% at 3-5 windows)
and 27 desktops instead of 7 were more than 10% from the best, for about 12% of
the time, so it is always on.

Push apart's pass limit ("Effort (passes)", default 1000) left the settings
window too: push apart stops as soon as nothing overlaps, and on the same 294
desktops it used at most 226 passes (30 windows; median 15 at 3 windows, 136 at
30) and never reached the limit. Raising it changes nothing; lowering it below
what a desktop needs only leaves overlaps for the cruder final cleanup. It
stays in the engine as a safety limit, and in the lab. Push apart's polish is
always on as well (it lowers push apart's score by 3-9%, 5.18, and push apart
is also the optimizer's safeguard candidate); the lab keeps the switch.

The figures in 5.3 and in this section are each measured against the best
score of their own set of runs, so they differ slightly for the same desktops,
and they predate 5.21.

### 5.21 The search's own gap estimate
The gap must be chosen in layout units before the final scale is known, from a
guess of how much of the screen the thumbnails will cover (`DENSITY_GUESS`,
50%). Gradient descent packs to about 75%, so its scale came out larger than
guessed and the gap during the search 10-28% wider than the setting; the polish
then closed the gap, but the scale was already chosen too small. The search now
pads for 75% (`DENSITY_SEARCH`); the starting layouts keep push apart's padding,
so the push-apart start (and the safeguard's candidate) is still exactly the
push-apart algorithm. On the 294 desktops of 5.20 at 1000 steps, mean gap to
the best: 1.11% → 0.86% with the default gap (better on 180 desktops, worse on
51), 1.41% → 0.79% with 58 px (the default gap plus decorations; 170 better,
53 worse); the same time; push apart, ordered rows and equal grid unchanged.

### 5.22 Separate gaps side by side and one above the other
The Scale view's decorations need 28 px between thumbnails side by side (the
close buttons' overhang) but 50 px one above the other (close button and
title). With one gap the extension had to pass the larger, so thumbnails side
by side were 22 px further apart than needed (seen with margin and gap at 0).
The engine now takes `extraGapX` and `extraGapY` on top of `gap`: the padding,
gap enforcement, scale, ordered rows, equal grid, polish and gap filling use
each in its own direction. They default to 0, and are not user settings; Expo
needs the same room in both directions and leaves them at 0.

Polish: separations are measured between thumbnails widened (or heightened)
by the difference between the gaps and held to the smaller gap, which is the
same as each gap in its own direction. A pair already closer than that (gaps
too large for the screen) also may not get closer in its real separation;
without that rule, a review found the polish could make such a pair overlap
(up to 0.6 px, only with extra gaps of 180 px and more on crowded screens).

Baseline first: with both at 0, every algorithm gives the same layouts as
before (294 random desktops as in 5.20, regenerated: 1920×1053 and 2560×1440,
3-30 windows; 7 setting variants, the optimizer's only at its defaults from
21 windows; 7728 layouts, the largest difference 1e-12, from rounding). With
the decorations above and the then default gap and margin (8 / 16), against
the old single gap of 58 px, per desktop:

| Algorithm  | Score better / worse | Worst  | Mean thumbnail scale        |
|------------|----------------------|--------|-----------------------------|
| Optimizer  | 271 / 23             | +0.25  | +1.8% (-11% to +13%)        |
| Push apart | 223 / 70             | +0.80  | +1.1% (-22% to +33%)        |
| Rows       | 276 / 18             | +0.43  | +1.7% (never smaller)       |
| Grid       | 245 / 49             | +0.06  | +1.5% (never smaller)       |

* Optimizer and push apart: noise between local minima. Narrowing the old
  single gap by just 2 px gives the same pattern (optimizer worse on 47,
  push apart on 60, worst +0.84), and the optimizer is worse by more than 0.1
  on 1 desktop, against 12 for that 2 px change.
* Ordered rows picks the row count by the largest scale, not by the score; 10
  of its 18 picked another row count (thumbnails never smaller).
* Optimizer against the best layout found on each desktop by any of four runs
  (old and new, each at default and at 10× effort with 8 starts; the old
  layouts are valid for the new gaps): mean distance 0.029 (new) vs 0.115
  (old), over 0.1 on 34 vs 134 desktops; with gap and margin 0: 0.026 vs 0.109,
  33 vs 138.
* Window titles are now limited to the smallest thumbnail width + 36 px instead
  of + 58 (still no title reaches a neighbor's title or thumbnail).


## 6. Verified facts about Cinnamon 6.0.5

All read from the official source (github.com/linuxmint/cinnamon, tag 6.0.5),
whose files are byte-identical to those installed on the target system (SHA-256
in `tests/lib/cinnamon.js`).

* **Scale view** (`js/ui/workspace.js`): `WorkspaceMonitor` per monitor per
  workspace. `positionWindows()` gives slot *i* to window *i* of
  `this._windows`; `_computeAllWindowSlots(n)` only knows the count;
  `syncStacking()` sorts `_windows` by minimized state, then stacking.
  `setGeometry()` uses the full monitor with a margin of 1% of its width.
  Keyboard: `selectAnotherWindow()` with `misc/gridNavigator.js`.
* **All workspaces are laid out when the view opens** (`workspacesView.js`
  creates every workspace and calls `zoomToOverview()`), in index order, so you
  can switch workspaces inside the view. Empty workspaces are skipped by the
  extension.
* **Workspace names:** index from 0 internally; shown as the custom name or
  "Workspace " + (index + 1) (`main.js` `getWorkspaceName`). Monitors are
  indexed from 0 in `Main.layoutManager.monitors`; their order isn't known to
  match Display settings.
* **Extension loading** (`js/misc/fileUtils.js`): files run inside a wrapper
  providing `require`, `exports`, `module`; top-level names are auto-exported
  unless the file assigns `module.exports` at the start of a line. Required
  functions: `init`, `enable`, `disable` (`js/ui/extension.js`); `enable()` may
  return an object whose functions settings-dialog buttons can call
  (`extensionSystem.js`, `cinnamonDBus.js`). `metadata.json` must have uuid,
  name, description, cinnamon-version; `url` is checked for non-emptiness only
  (warning) and not otherwise used by the Extensions dialog.
* **Settings** (`js/ui/settings.js`, `xlet-settings.py`, python3-xapp):
  supported widget types include switch, scale, spinbutton, combobox, button,
  section, layout pages; `dependency` supports `key`, `!key` and comparisons
  (`=`, `!=`, `<`, ...). A layout must be the file's first entry. Saved values
  live in `~/.config/cinnamon/spices/<uuid>/`. When the schema changes (any
  byte, so every release that touches it), saved values are kept, new settings
  get defaults, and values that fail Cinnamon's check go back to the default:
  a drop-down value no longer offered, and on 6.0-6.6 also a value at either
  end of its range (`val < max && val > min` in `settings.js`; 6.8 accepts the
  ends). So a user's largest thumbnail scale of 1, a margin or gap of 0, a
  weight of 0 or an effort of 1 or 100 is reset by such an update; the release
  notes should say so (9.2).
* **Expo** ("Show all workspaces") is separate: `js/ui/expoThumbnail.js`,
  `ExpoWorkspaceThumbnail.overviewModeOn()`, has its own grid per monitor
  (spacing 14) and also orders windows by stacking ("top-to-bottom order"),
  sorted in its own `syncStacking()`. `overviewModeOff()` animates back to
  `origX/origY` (the actor's real position). Clones are positioned by the window
  actor (`realWindow.x/y/width/height`), which includes invisible borders.

### 6.1 Cinnamon 6.2 to 6.8

Tested against the source of the latest release of each series (as of November
2026): 6.0.5, 6.2.10, 6.4.14, 6.6.9, 6.8.0. All tests pass on all of them.

* **6.0 to 6.6** share the same extension loader (`createExports()` in
  `fileUtils.js`, providing `require()`) and the same object-style
  `WorkspaceMonitor`.
* **6.8** changed both:
  * Extensions are loaded by GJS's **native importer**: an extension's top-level
    `var` and `function` declarations are its exports; local files are reached
    through `imports.ui.extension.getCurrentExtension().imports` (which works
    while the main file is loading, via `currentlyLoadingExtension`).
    `require()` and `module.exports` still work through a shim
    (`globalThis.require = xletRequire`) but log a **deprecation warning**. The
    extension therefore uses `getCurrentExtension()` when it exists and
    `require()` otherwise. The engine's `var SpreadLayout` is what the native
    importer exposes; its `module.exports` line is only used by the `require()`
    paths.
  * `WorkspaceMonitor` is a class (`GObject.registerClass(class WorkspaceMonitor
    extends Clutter.Actor ...)`). The methods the extension replaces are
    ordinary prototype methods with unchanged names and slot format, so patching
    works the same way.
  * `_computeWindowLayout()` no longer rounds positions down, so thumbnails land
    exactly where the engine puts them (0.00 px deviation in the tests).
  * New `prepareOverviewGesture()` (for touchpad gestures) also calls
    `_computeAllWindowSlots()` and `_computeWindowLayout()`: the same layout,
    usually from the cache, and one more diagnostics line per gesture. Not
    covered by a test.
* `cinnamon-version` in `metadata.json` lists **minimum** versions (Cinnamon's
  `versionCheck()`, unchanged from 6.0 to 6.8), so `"6.0"` alone would cover
  all of these. It lists every tested series anyway (6.0 to 6.8), so anyone
  reading it (users, Spices) sees what is tested; add a series once it has been
  tested (section 7).

### 6.2 Measured on the target system

Via the diagnostics log:

* Decorations: top 14, bottom 36, left 14, right 14 px. With the default gap of
  4 px this gives effective gaps of 32 px side by side and 54 px one above the
  other. Because the decorations are added to margin and gaps automatically,
  the Show all windows defaults are small (8 / 4).
* Minimized windows report their normal frame (e.g. 1154×761 at 1321,605).
* First computation, optimizer, Show all windows (Ryzen 9 5900X, 2026-11-13):
  1 window 0.2-0.5 ms, 2-3 windows 2.4-6.3 ms (the highest is the first layout
  of an opening, see below), 8 windows 4.3-4.9 ms, 20 windows 8.8-10.5 ms.
  Before 5.20 (simulated annealing): 8 windows 8-12 ms, 21 windows 22-24 ms;
  before 5.18: 8 windows 13-17 ms. Cache hits: about 0.2 ms.
* Show all workspaces, caching off, same windows: the optimizer varied far more
  than in Show all windows (8 windows 2.9-20.9 ms, 20 windows 33.7 ms), the
  equal grid 0.1-1.8 ms. The engine does the same work in both views (in Node,
  Expo's settings and smaller areas take as long as Scale's), and the fastest
  Expo runs match Scale's, so the extra time is Cinnamon's, while the view
  animates; not pursued further.
* Margins at 0 in both views: no window title or close button is cut off at the
  screen edge (checked 2026-11-13; a review had calculated that titles might
  overhang).
* The first layout computed when a view opens takes 5-7 ms longer than the
  same layout computed later in that opening, whichever workspace it is (tested
  by making another workspace the only one to recompute). A cost in Cinnamon
  between openings, not in the engine; not pursued further (user's decision).


## 7. Testing

Run everything with `node tests/run-all.js` (Mint: `sudo apt install nodejs`).
About 160 checks, a few seconds. Against several Cinnamon versions at once:
`node tests/run-versions.js` (default: the latest of each series from 6.0 to
6.8) or `node tests/run-versions.js 6.8.1 6.8.2` for specific ones.

* `tests/engine.test.js`: the guarantees for all algorithms, at the defaults
  and with settings at the ends of their ranges on small and offset monitors
  (all-maximized and oversized windows, fill gaps, the order method, fixed row
  counts, the fewest push-apart passes), errors for input that can't be laid
  out and for settings outside their allowed values, `score()`, uniform scale,
  thumbnails held at the max scale not charged for uneven sizes, always
  centering, monitors elsewhere, the optimizer safeguard whatever it starts
  from, the cache, rebuilding from the factory, and the grid's nearest-cell
  assignment (against brute force, also the Hungarian method on its own with
  ties and negative costs).
* `tests/schema.test.js`: `settings-schema.json` equals the generator's output;
  defaults match the engine; the extension reads exactly the defined settings;
  widget types and required fields as Cinnamon's dialog and `settings.js`
  expect; pages; `metadata.json` against the required properties and the real
  `versionCheck()` of that Cinnamon version.
* `tests/extension.test.js`: the extension against Cinnamon's real code. It
  loads the extension with that version's real loader: `createExports()` from
  `fileUtils.js` on 6.0-6.6; on 6.8, the `require()` shim, `module`/`exports`
  handling and `getCurrentExtension()` from `extension.js` (only GJS's native
  importer is simulated). It builds the Scale view's `WorkspaceMonitor` from the
  real methods in `workspace.js` (object-style or class-style), with Cinnamon's
  grid navigator and workspace naming. For Show all workspaces, it runs
  Cinnamon's real `overviewModeOn()` and the extension's replacement side by
  side on identical simulated windows (two monitors, invisible borders, a
  minimized window, one that doesn't belong, one being dragged) and checks the
  same behavior (hiding, clone refresh, urgency, icon size and offset,
  visibility after animating), exact placement of visible frames, independence
  from stacking (where Cinnamon's own depends on it), separate cache slots,
  every algorithm, switched-off equals Cinnamon exactly, error fallback, and
  edge cases (repeated calls, empty monitor, oversized window, 30 windows). Then
  it checks that Cinnamon's own fitting code places thumbnails where the engine
  says, decorations never collide, stacking and minimizing have no effect,
  caching per workspace and caching switched off, a monitor not at 0,0,
  diagnostics, keyboard navigation, fallback on errors and on input the engine
  refuses (also for keyboard navigation and Expo), a repeated failure logged
  only once, a second `enable()` (also after one that failed half-way), and
  that disabling restores the originals.
* `tests/lab.test.js`: the lab in a simulated browser (needs `jsdom`, see the
  file; skipped otherwise).
* `tests/spices.test.js`: `tools/build-spices.js` builds a package with exactly
  the extension's committed files, refuses uncommitted changes and stray files
  (tried on a temporary clone), uses the whole folder outside a git clone (an
  unpacked ZIP), and Spices' own `validate-spice` accepts it (needs python3
  with PIL; skipped otherwise).
Cinnamon sources: the installed files in `/usr/share/cinnamon` are used if
present; otherwise (or with `CINNAMON_SOURCE=download`) the version from
`cinnamon --version` (or `CINNAMON_VERSION`, default 6.0.5) is downloaded from
GitHub into `tests/.cinnamon-src/`. The output notes whether the files match
6.0.5.

**Checking a new Cinnamon version:** run `node tests/run-versions.js <version>`
(or `node tests/run-all.js` on the upgraded system). If it fails, compare the
version's `js/ui/workspace.js` (the five `WorkspaceMonitor` methods listed at
the top of `tests/extension.test.js`), `js/ui/expoThumbnail.js`
(`overviewModeOn()`; the tests fingerprint it) and its extension loader
(`js/misc/fileUtils.js`, `js/ui/extension.js`) with the last version that
passed. If a new release changes the loader again, `makeLoader()` in
`tests/extension.test.js` needs a matching branch, built from that version's
real code like the existing two.

Not testable here: a real Cinnamon session (rendering, animation, real input).
The checks on the target system are in README's "Troubleshooting".


## 8. Open items

* **Stability between invocations** (keep thumbnails where they were when only
  one window changed): would need the previous layout as an extra starting
  point; not started.
* **Future Cinnamon versions:** 6.0 to 6.8 are tested. For newer releases, run
  `node tests/run-versions.js <version>` first (section 7). The `require()`
  fallback is only needed for 6.0-6.6 and can be dropped once those are no
  longer used.


## 9. Publishing

Cinnamon Spices is where users get the extension: Cinnamon's own Extensions
dialog (Download tab) installs and updates from it. GitHub holds the source;
its main branch is the development state. A release is a pull request to the
Spices repository that gets merged; no GitHub Releases are made.

**Version:** `version` in `metadata.json`. It is for people, not for Cinnamon,
which notices updates from Spices by itself. Raise it for each Spices release
and tag that commit `v<version>`, so it is clear which commit users have.

**Files:**

* `node tools/build-spices.js` builds `dist/spices/<UUID>/` in the structure
  Spices requires: `info.json` and a Spices-specific `README.md` from
  `tools/spices/`, `screenshot.png` from `docs/`, and `files/<UUID>/` = the
  extension folder. It checks the result against Spices' rules, the same as
  their `validate-spice` script. `tests/spices.test.js` runs the real
  `validate-spice` on a build (needs python3 with PIL; Mint: `python3-pil`).
* `info.json` names the author by GitHub username (`soren-kragh`). Spices
  reviews pull requests from the author more lightly than from others.
* The Spices README may link to the repository only for bug reports and
  development: Spices forbids pointing users to downloads elsewhere. The GitHub
  README's Install section is for visitors who want the latest source.
* `docs/screenshot.png` (Show all windows in use) is shown on GitHub and on the
  Spices website.
* Icon: `docs/icon.svg` is the source; render it to the extension's `icon.png`
  at 256×256 (square, as Spices requires).
* License: MIT-0 (`LICENSE`, also inside the extension folder so the Spices
  copy states it explicitly; the Spices repository's own default is GPL
  version 2).

### 9.1 One-time setup for Spices

1. On GitHub, open `https://github.com/linuxmint/cinnamon-spices-extensions`
   and click **Fork**. This makes your own copy,
   `soren-kragh/cinnamon-spices-extensions`, which you can push to.
2. Clone your fork next to this repository (the commands below assume both are
   in the same folder) and connect it to the original:

   ```
   git clone https://github.com/soren-kragh/cinnamon-spices-extensions.git
   cd cinnamon-spices-extensions
   git remote add upstream \
     https://github.com/linuxmint/cinnamon-spices-extensions.git
   ```

3. Read the rules once: the repository's `README.md` and
   `.github/CONTRIBUTING.md`. Since this code was written with AI help, also
   read `.github/copilot-instructions.md` (the reviewers' checklist; they ask
   AI-assisted authors to review their code against it before submitting).

### 9.2 Making a release

In this repository:

1. Make sure everything is committed and `node tests/run-all.js` passes (the
   build in step 3 refuses uncommitted changes in the extension folder).
2. Raise `version` in `metadata.json`, commit, tag and push:

   ```
   git tag v1.0
   git push
   git push --tags
   ```

3. Build the Spices folder: `node tools/build-spices.js`.

In the clone of your fork (`cd ../cinnamon-spices-extensions`):

4. Bring it up to date and start a branch for this release:

   ```
   git checkout master
   git pull upstream master
   git checkout -b window-spread-1.0
   ```

5. Replace the extension's folder with the new build and check it:

   ```
   rm -rf window-spread@soren-kragh
   cp -r ../window-spread/dist/spices/window-spread@soren-kragh .
   ./validate-spice window-spread@soren-kragh
   ```

6. Commit and push. The message must start with the extension's identifier and
   a colon, or Spices closes the pull request:

   ```
   git add window-spread@soren-kragh
   git commit -m "window-spread@soren-kragh: Add extension"
   git push -u origin window-spread-1.0
   ```

   For later releases, say what changed, e.g.
   `"window-spread@soren-kragh: 1.1, faster layouts"`.
7. Open your fork on GitHub; it offers **Compare & pull request** for the new
   branch. Check that it goes to `linuxmint/cinnamon-spices-extensions`, branch
   `master`, give it the same title as the commit, describe the release in a
   few lines, and create it. One pull request per extension. If
   `settings-schema.json` changed since the last release, mention that on
   Cinnamon 6.0-6.6 settings left at either end of their range go back to their
   defaults (section 6), so users should check them.
8. Wait for the review. Spices' automatic check runs first; reviewers may ask
   for changes. To make them: fix and commit here, rebuild (step 3), then in
   the fork's clone, still on the same branch, repeat step 5 and commit with a
   message like `"window-spread@soren-kragh: Address review"`, followed by a
   plain `git push`. The pull request updates by itself.
9. Once merged, the release is on the Spices website and in Cinnamon's
   Extensions dialog, and users who have the extension get an update. Delete
   the branch (GitHub offers a button on the pull request).

### 9.3 After the first release

* Change the GitHub README's Install section to recommend installing from
  System Settings → Extensions → Download, keeping the copy-from-git steps for
  the latest development version.
* Spices users report bugs as issues in the Spices repository, titled
  `window-spread@soren-kragh: ...` and mentioning you, as its guidelines ask.

## 10. Workflow for changes

1. Change the engine and try it in the lab (it loads the same file).
2. Changed a default or a setting's label, range or page? Edit `DEFAULTS` or
   `tools/build-schema.js`, then run `node tools/build-schema.js`.
3. Run `node tests/run-all.js`.
4. Replace the installed copy with the two commands under "Updating" in README's
   Install section (delete the old folder, then copy), and restart Cinnamon
   (Alt+F2, `r`). If defaults changed, choose **Reset to defaults** in the
   settings window's menu (top right).
5. Record new decisions and evidence in section 5 of this file.
6. To publish a release: section 9.2.
