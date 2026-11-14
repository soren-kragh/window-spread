# Window Spread: development notes

For whoever continues this project, human or AI. `README.md` covers installing
and using the extension; this file covers how it works, why, what is verified,
and what is open. Read it before changing anything: several "obvious
improvements" were tried and are recorded here as rejected, with the evidence.


## 1. Goal

Arrange Cinnamon's **Show all windows** (Scale) and the windows inside each
workspace in **Show all workspaces** (Expo) so that thumbnails stay near their
real windows, keep their relative sizes, and **never depend on stacking order or
focus history**. That last point is the motivation: Cinnamon's own Scale view
fills a grid in stacking order, so the arrangement changes whenever another
window was focused. Status: works on the target system (Linux Mint 21.3,
Cinnamon 6.0.5, one 2560×1440 monitor) and on a fresh Linux Mint 22.3 install
(Cinnamon 6.6.9), tested against the source of Cinnamon 6.0 to 6.8 (section
6.1).


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

* **One engine.** `spreadLayout.js` exists once. The extension loads it through
  `getCurrentExtension().imports` on 6.8+ or `require()` on 6.0-6.6 (6.1); the
  lab loads it with a `<script>` tag, and its tuner threads rebuild it from
  `createSpreadLayout.toString()`. Never paste engine code elsewhere. So the
  lab only works from inside this folder.
* **Defaults live in the engine** (`DEFAULTS`, section 1 of `spreadLayout.js`);
  the lab reads them from there. Settings that exist only in the settings
  dialog (each view's algorithm, Show all workspaces' margin and gap, the Enable
  switches, caching, diagnostics) have theirs in `tools/build-schema.js`.
  `settings-schema.json` is generated from both: run `node
  tools/build-schema.js` after changing a default. A test fails if they differ.
* **The engine knows nothing about the DOM, Cinnamon or stacking.** Its input
  is window frames `{id, x, y, w, h}` and a monitor rectangle.
* **The engine is stateless and deterministic.** The cache is a separate,
  optional helper, `SpreadLayout.createCache()`.
* **JavaScript:** nothing newer than about ES2018 (Cinnamon 6.0's engine). The
  tests avoid `?.` and `??` so they run on Mint 21.3's Node 12.


## 3. Architecture

### Engine (`spreadLayout.js`)

The public API is documented at the top of the file. `compute()` runs:

1. **Algorithm**, one of
   * `optimizer`: gradient descent over window centers in "layout units" (true
     relative sizes, one shared scale) on a smoothed copy of the score, from
     several starting layouts that race (5.3).
   * `push`: push apart overlapping windows, then scale to fit.
   * `rows`: ordered rows; the row count giving the largest scale (not the best
     score) wins.
   * `grid`: equal grid, each window in its nearest cell (5.8). Scales windows
     unevenly.
2. **Placement:** unless `centered`, the arrangement moves as a whole toward the
   real windows, as far as the work area allows (5.2).
3. **Polish** (optimizer, push): greedy small moves into free space that lower
   the score (5.2).
4. **Safeguard** (optimizer): the push-apart and ordered-rows layouts are
   finished the same way, and the best-scoring layout wins (5.6).
5. **Fill gaps** (optional): thumbnails grow into free space.
6. **Score.**
7. **Center** (if `centered`): last, because the polish, the safeguard and gap
   filling would undo an earlier centering; after the score, because the user
   asked for this move, so it shouldn't count as a worse fit.

All of it runs relative to the monitor's corner, so the result is the same
wherever the monitor is.

**Score** (lower is better; it drives the optimizer, the polish and all
comparisons): `wSize × size + wSizes × distortion + wPlace × movement +
wRelations × relations`, plus an overlap term that only matters during the
search. Size is the mean −ln(scale) after removing the intended size-fidelity
factor (thumbnails held at the max scale: 5.4). Distortion is the mean absolute
deviation of log scales (0 for one shared scale). Movement is the mean distance
from real centers, relative to the screen diagonal. Relations: "order"
(left/right, above/below flips, weighted by orientation) or "direction" (change
of angle between window pairs, with neighbor focus); see 5.7. Internal
constants are in `INTERNAL`, with comments.

### Extension (`extension.js`)

**Show all windows.** While enabled, two methods of Cinnamon's
`WorkspaceMonitor` (`js/ui/workspace.js`) are replaced:

* `_computeAllWindowSlots(n)` calls the engine (through the cache, one slot per
  monitor and workspace) and returns per window a slot of its thumbnail plus
  Cinnamon's decorations. Cinnamon's own `_computeWindowLayout` then puts the
  thumbnail exactly where the engine said; animations, titles and clicks stay
  Cinnamon's.
* `selectAnotherWindow(symbol)`: arrow keys go to the nearest thumbnail in that
  direction (Cinnamon's version assumes its grid).

Both fall back to Cinnamon's original on any error or unusable result (checked:
one finite target per window, sizes above 0), and while `scale-enabled` is off;
after a fallback, keyboard navigation follows Cinnamon's grid too. Keyboard
navigation checks the switch itself, since clones keep the extension's
positions if it is switched off while the view is open.
Details:

* **Decorations** (`WindowOverlay.chromeWidths/chromeHeights`): the engine gets
  the monitor shrunk by them, and as extra gaps `extraGapX` = left + right
  between thumbnails side by side and `extraGapY` = top + bottom one above the
  other (5.5). Cinnamon reserves the close button's room on both sides, since
  the button follows the window-button layout.
* **Title width:** Cinnamon gives every title one maximum width, `_slotWidth`,
  centered under its thumbnail. The extension sets it to the smallest thumbnail
  width plus the gap side by side (titles can't reach a neighbor), but adds at
  most twice the room at the screen's edges (they can't run off the screen).
* **Margin:** replaces Cinnamon's 1% margin. **Max scale:** at most 1, as
  Cinnamon caps thumbnails there.
* **Identity:** `metaWindow.get_stable_sequence()`, as Cinnamon uses.
  **Minimized windows** are passed with their normal frame.
* **Keyboard navigation** keeps thumbnail centers in the extension's own
  `WeakMap`, not on Cinnamon's objects (GObject classes from 6.8 on).
* **Settings** are read on every layout; the cache key includes them. Resetting
  is left to the dialog's **Reset to defaults**: an extension button calling
  `setValue` per key raced with the dialog's own saving and left some unreset.
* **Lifecycle:** `enable()` reads the settings before patching; each
  replacement keeps its own reference to the original, so a call after
  `disable()` still reaches Cinnamon's code. A second `enable()` disables first.
* **Diagnostics** (setting "Write diagnostics to the log"): one line per
  workspace per opening, minimized window frames, decoration sizes once.
  Errors are logged always, each distinct one once per enable.

**Show all workspaces (Expo).** `ExpoWorkspaceThumbnail.overviewModeOn()`
arranges a workspace's windows with the grid calculation inline, so the whole
method is replaced by `expoOverviewModeOn()`, which performs Cinnamon's steps
(hide windows that don't belong, refresh clones, urgency, app icons, the same
animations and completion callbacks) with positions from the engine. Rejected:
letting Cinnamon's method run and re-animating afterwards; that cancels
Cinnamon's animations, whose completion callbacks make windows visible again.

* Falls back to Cinnamon's original on any error and while `expo-enabled` is
  off.
* One engine call per monitor, over its full area; a window being dragged keeps
  its place but isn't moved (as in Cinnamon). All monitors' layouts are
  computed and checked before anything moves.
* The engine lays out visible frames; Expo positions window *actors*, which
  include invisible borders: `scale = target.w / frame.w`, `actor.x = target.x
  − (frame.x − actor.x0) × scale` (same for y).
* App icon badges: 32 px on screen as in Cinnamon, anchored to the visible
  frame's corner (5.12), 5 screen px out to the left and up; that room goes into
  the margin (left, top) and the gap. Cinnamon's constants (100 ms, −5, 0.25)
  aren't exported, so they're repeated; a test compares them with each version.
* 6.0-6.6 keep the clone in `window.actor` and the scale in `box.scale`; 6.8
  makes the clone the actor and renames the scale `box.thumbnail_scale`. A test
  fingerprints Cinnamon's method, so a future change is flagged.
* Own settings: Enable switch, algorithm (default optimizer), margin and gap
  (default 14 px, as Cinnamon), and its own size fidelity, max scale, centering,
  gap filling and max growth (`EXPO_SETTINGS_MAP`). Scoring weights and the
  algorithms' settings are shared. Cache slots `expo/<monitor>/<workspace>`.

With both Enable switches off, behavior equals Cinnamon's exactly (tested:
slots, title width, every arrow key, Expo positions, badges, visibility).

### Lab (`lab/window-spread-lab.html`)

Simulated 1920×1080 desktop with the four algorithms and all settings,
comparison view, measurements, cache and minimize simulation, and a
multi-threaded tuner (Web Workers running the engine rebuilt from its factory).
Help texts are in the `INFO` object and the `*_UI` tables.


## 4. Guarantees (covered by tests, at defaults and at the ends of the ranges)

The optimizer is tested at reduced effort; effort only changes how far the
search gets, not what the guarantees rely on (cleanup, gap enforcement and
safeguard run the same at any effort).

* No stacking order, focus or minimized state is used; input order doesn't
  matter.
* Deterministic. Moving the monitor and its windows together by whole pixels
  (e.g. a second monitor) moves the layout along exactly.
* No overlaps; inside the monitor minus `margin` (to 0.5 px); scale at most
  `maxScale`; finite positions, sizes above 0.
* Gaps at least `gap`, plus `extraGapX` side by side or `extraGapY` one above
  the other (tested up to 58 px), unless they leave no room: with very large
  gaps (e.g. 130 px, 12+ windows on 1366×768) push apart's overlap removal stops
  short; the equal grid shrinks its gaps; ordered rows with a fixed row count
  that doesn't fit uses the best count instead.
* Push apart, ordered rows and the optimizer use one shared scale.
* The optimizer never scores worse than push apart or ordered rows with the
  same settings (`pushStart`, `rowsStart`), as long as gap filling is off.
* Input that can't be laid out (non-finite numbers, size 0, settings outside
  their allowed values) is an error, not an unusable layout.


## 5. Design decisions and the evidence behind them

Each decision with its reason and the measurement behind it; rejected
alternatives are listed so they aren't tried again. Scores come from different
scoring rules and weights; compare numbers only within one paragraph or table.
Numbers marked "(annealing)" were measured while the optimizer's search was
simulated annealing (5.3); they support the decision but don't describe today's
optimizer. Test desktops: 294 random desktops of 3-30 windows (2560×1440 and
1920×1080, three size mixes); "gap to best" = how much worse than the best
score in that set of runs on that desktop, so figures from different run sets
differ slightly for the same desktops.

### 5.1 Processing order
Windows are sorted by center y, center x, width, height, then id before
anything else, so every algorithm is independent of input order and stacking.

### 5.2 Placement toward real windows, and the polish
Centering the arrangement makes edge windows counterweights for the others,
and a search can leave slack, so thumbnails stay away from their windows
although free space would let them closer. Moving the arrangement toward the
real windows and a greedy polish: layouts where a window could move 60 px
closer into free space 24 → 1 of 80 (relations off), 62 → 47 with relations on,
the rest being genuine trade-offs (annealing, 12 windows). Placement, gap
filling and centering apply to the one-scale algorithms, not the equal grid.

The polish is exact but cheap: the "before" value is computed once per
position, only neighbors within reach of the step are checked, overlap terms
are skipped while nothing overlaps (they are exactly 0), and a thumbnail whose
scan found nothing waits until something else moves. The safeguard skips a
candidate's polish when a lower bound (`polishLowerBound`) shows it can't win.
Results are identical to checking everything (5842 layouts); at 30 windows push
apart takes 1.6 ms instead of 6.8. The polish lowers push apart's score by
3-9%, and without it the optimizer's mean gap to best is 3.3% instead of 1.4%
(5.3), so it is always on. Rejected: heuristics (skip uphill directions, stop on
small gains, cap passes) for another 1.5-2×; they change results (push apart up
to 8% worse on single desktops).

### 5.3 Optimizer: gradient descent
Gradient descent (Adam) moves all windows at once, on a copy of the score whose
corners are smoothed. The overlap weight grows from 3 to 300, so the
arrangement first contracts through overlaps and then separates (as in
analytical chip placement); the step size shrinks from `firstStep` (0.3 of the
average window size) to 0.0005.

Rejected: simulated annealing, which moves one window at a time. In a tight
arrangement, shrinking needs many windows to move together, so it ends far from
the best on crowded desktops; at 50k moves it was still more than 10% off on 63
desktops. Gradient descent here is before the search padding below:

| windows | annealing 10k: >10% / gap / ms | 1000 steps | 500 steps |
|---|---|---|---|
| 3 | 0 / 0.2% / 2.2 | 0 / 0.1% / 0.6 | 0 / 0.1% / 0.4 |
| 8 | 9 / 6.5% / 3.7 | 3 / 2.2% / 1.4 | 2 / 1.8% / 0.9 |
| 16 | 32 / 18.2% / 6.4 | 0 / 1.0% / 3.5 | 0 / 1.7% / 2.2 |
| 30 | 32 / 17.5% / 11.7 | 0 / 1.3% / 9.2 | 0 / 1.8% / 5.7 |
| all 294 | 128 / 10.5% | 5 / 1.3% | 5 / 1.6% |

(">10%": desktops more than 10% from the best, of 42 per row; mean gap to best;
median time in Node.) From 12 windows up, gradient descent's thumbnails cover
73-76% of the screen instead of 60-67%. Also rejected: tuning the annealing,
other move kinds (swaps, one axis, jumps), gradient refinement after annealing
(2-3% better), and annealing plus a relocation search (behind from 12 windows
up, and much more code).

* **Starts:** one per starting layout (push apart, ordered rows, equal grid,
  real positions), racing: at checkpoints (from 0.2 of the schedule, then
  evenly to the end) the worse half is dropped. In a separate run set: as good
  as running all four to the end at 1000 steps (>10%: 7 vs 5; mean gap 1.38% vs
  1.40%), clearly better at 500 (6 vs 12; 1.69% vs 2.56%). 3 starts are a little
  worse (6, 1.61%), 8 a little better (4, 1.30%) for the same time. With
  "mixed" starts and up to four of them nothing is random. No single start kind
  wins everywhere.
* **Padding during the search:** the gap must be set in layout units before the
  final scale is known, from a guess of the screen coverage (`DENSITY_GUESS`,
  50%, for push apart and the starting layouts). Gradient descent packs to about
  75%, so the search pads for 70% coverage (`DENSITY_SEARCH`; 75% instead of
  50% cut the mean gap to best from 1.11% to 0.86%, 70% is better still). The
  starting layouts keep push apart's padding, so the push-apart start stays
  exactly push apart.
* **Tuning:** the constants were searched one at a time and in combination
  (324 sets), then checked on three new sets of 294 desktops, against the
  spread from merely nudging today's values (noise). The overlap weight's
  schedule (3 to 300), the first step size (0.3), the checkpoint and Adam's
  constants are at their best; overlap start 1 or 10 gives 4-5× more desktops
  over 5%. Smoothing 0.02 (was 0.05), last step 0.0005 (was 0.0002) and
  padding 70% (was 75%) together: desktops over 2% 185 → 155, over 5% 28 → 21,
  mean gap 1.13% → 1.00% (noise: 182-193, 29-37, 1.09-1.16%); better at
  effort 5 and 30 too, the same with the order method, mixed for Show all
  workspaces-like settings (over 5%: 15 vs 10, noise 9-12). The worst desktops
  (13-23% off) need another start, not other constants.
* **Cost:** a step moves every window and checks every pair (n² work).
* **Settings:** only the effort is in the settings window (5.9). Starts,
  checkpoint, first step, start kind, seed and polish are fixed; the lab keeps
  them. Without polish the mean gap would be 3.3% instead of 1.4%.
* **Push apart's pass limit** (1000) isn't a user setting: push apart stops as
  soon as nothing overlaps (at most 226 passes on the test desktops); a lower
  limit only leaves overlaps for the cruder final cleanup. It stays as a safety
  limit.
* **Also rejected:** a size term charging thumbnails held at the max scale,
  with extra steps steering the descent back below the limit; 5.4 made it
  unnecessary.

### 5.4 Size term and the max scale
Uneven scaling is charged ("Keep sizes"): otherwise the equal grid wins on
score just by enlarging small windows more than big ones. It isn't in the
extension's settings, where it only affects the equal grid and gap filling,
which don't search by the score; the lab keeps it for fair comparisons.

A thumbnail held at the max scale counts as large as the largest one that isn't
(as the max scale if all are). Charging it would reward shrinking larger
windows below the limit so that ratios match: smaller thumbnails, scored as
better. On 300 desktops of 2-8 windows (annealing, max scale 1 and 0.9) the
optimizer's layout changed on 45 (34 at 0.9), always to bigger thumbnails in
total, never with fewer windows at the max scale. The max scale defaults to
0.9: at 1, one window or a few that fit look exactly as on the desktop, so the
view seems to do nothing.

### 5.5 Gaps
* **Exact gaps:** push apart and the optimizer widen the padding until the real
  gap is right, and scale by the windows' extent, with no half-gap around the
  outside. `GAP_ROUNDS` is 100: most layouts settle in the first rounds, but
  crowded ones (20-30 windows, e.g. a portrait monitor) need more; with 8 they
  end up to 0.7% short.
* **Separate gaps side by side and one above the other** (`extraGapX`,
  `extraGapY`; default 0, not user settings): the Scale view's decorations need
  28 px side by side but 50 px one above the other. Every algorithm, the polish
  and gap filling use each in its own direction. Compared with one gap of the
  larger value: thumbnails 1.1-1.8% larger on average, and the optimizer more
  than 0.1 from the best layout of any run on 34 desktops instead of 134; scores
  worse on some desktops in the same pattern as narrowing a single gap by 2 px
  (local minima). Expo needs the same room both ways and leaves them at 0.
* The polish measures separations between thumbnails widened or heightened by
  the difference between the gaps, held to the smaller gap; a pair already too
  close (gaps leaving no room) may not get closer in its real separation
  either, or it could come to overlap.

### 5.6 Optimizer safeguard
A start from push apart or ordered rows doesn't guarantee beating them: the
descent doesn't keep its start, and the rows start is a converted layout. So
the finished push-apart and ordered-rows layouts (with the algorithms' own
settings, `pushStart`/`rowsStart`) compete with the search result: 0 losses in
288 runs. Layouts the search already built as starts are reused.

### 5.7 Relations
* **Order** weights a pair's left/right relation by cos² of the angle between
  the windows and above/below by sin². Otherwise two windows far apart at
  almost the same height count as "above/below" and hold each other in place
  (measured: 90 px from home instead of 1 px).
* **Rejected:** capping the Direction penalty for already-broken relations. It
  weakens the relations term overall, so the optimizer packs tighter instead (a
  test window's distance from home 153 → 170-234 px, annealing). The fix was
  the weights:
  neighbor focus 0.5, keep relations 1, stay in place 2.

### 5.8 Equal grid: nearest cell
Each window goes in its nearest cell: the assignment with the smallest total
distance, solved exactly by the Hungarian method (`assignOptimal`, about 0.3 ms
for 20 windows, verified against brute force). It puts windows 7-14% closer to
home on average than filling cells in reading order, which isn't offered as an
option (user's decision).

### 5.9 Effort, no time budget
A wall-clock limit would break determinism; an effort derived from the window
count would work. Rejected (user's decision): the user knows their PC and sets
the effort, 1-100 (`optimizer-effort`, default 10, × 100 descent steps; the unit
is in `SETTINGS_MAP`). The tooltip says to lower it if opening gets choppy.

### 5.10 Cache
Last layout per slot (monitor and workspace), reused on an exact match of window
ids and frames, monitor, algorithm and engine settings. The key sorts windows
by id, so stacking and focus changes reuse it. Deferring other workspaces or
pre-warming the cache in the background isn't needed.

### 5.11 Settings window
* **Pages:** Mint's slider widget changes its value on scroll and swallows the
  event, so scrolling a long page changes sliders; the schema can't switch that
  off, and custom widgets would be more code and more fragile. Hence short
  pages (five, at most 9 settings each) and settings that don't apply hidden
  with `dependency`.
  A setting allows one condition, a section its own, so each view tab has its
  Enable switch in one section and the rest in a section shown only while it is
  on (6.0.5 to 6.8). Corner case: max growth follows fill gaps only, so it stays
  visible when fill gaps is on and the equal grid is chosen.
* **No spin button that can be 0:** the dialog only passes a value that differs
  from the widget's; a new spin button holds 0, so a setting of 0 shows blank.
  "Number of rows" is therefore a drop-down; margins and gaps are sliders (0-200
  px, steps of 2), which show 0 (checked on 6.0.5). A test enforces it.
* **Wording** (user's decisions): tooltips describe what the user sees, not how
  it works. The equal grid isn't called "Cinnamon-like", since unlike
  Cinnamon's it never depends on stacking (comparisons with Cinnamon's grid
  always state that difference); the optimizer isn't labeled
  "recommended". The algorithm tooltip uses one paragraph per choice, not
  bullets: GTK wraps tooltips at 70 characters without indenting.

### 5.12 Expo badges anchored to the visible window
Cinnamon positions an app icon badge from the window actor's corner, and the
actor includes invisible borders (wide shadows on GTK apps). Cinnamon spaces
actors; the extension spaces visible frames, so badges anchored Cinnamon's way
would land in the gap or over a neighbor. They are anchored to the visible
frame, with the overhang reserved in margin and gap; the default 14 px margin
and gap (Cinnamon's) are enough. The tests use windows with no, typical and
wide uneven invisible borders: uniform borders hide this problem.


## 6. Verified facts about Cinnamon 6.0.5

Read from the official source (tag 6.0.5), byte-identical to the files on the
target system (SHA-256 in `tests/lib/cinnamon.js`).

* **Scale view** (`js/ui/workspace.js`): one `WorkspaceMonitor` per monitor per
  workspace. `positionWindows()` gives slot *i* to window *i* of `_windows`,
  which `syncStacking()` sorts by minimized state, then stacking;
  `_computeAllWindowSlots(n)` only knows the count. `setGeometry()` uses a
  margin of 1% of the monitor width. Keyboard: `selectAnotherWindow()` with
  `misc/gridNavigator.js`.
* **All workspaces are laid out when the view opens**, in index order, so you
  can switch workspaces inside the view. The extension skips empty ones.
* **Names:** workspaces are indexed from 0 and shown as their custom name or
  "Workspace " + (index + 1); monitors are indexed from 0 in
  `Main.layoutManager.monitors`, not necessarily in Display settings' order.
* **Extension loading** (`js/misc/fileUtils.js`): files run in a wrapper
  providing `require`, `exports`, `module`; top-level names are exported unless
  the file assigns `module.exports` at the start of a line. `js/ui/extension.js`
  requires `init`, `enable`, `disable`, and uuid, name, description and
  cinnamon-version in `metadata.json`.
* **Settings** (`js/ui/settings.js`, `xlet-settings.py`): widgets include
  switch, scale, spinbutton, combobox, button, section and pages (a layout
  must be the schema's first entry); `dependency` takes `key`, `!key` and
  comparisons. Values live in
  `~/.config/cinnamon/spices/<uuid>/`. When the schema changes at all, saved
  values are kept, but values that fail the check return to the default: a
  drop-down value no longer offered, and on 6.0-6.6 also a value at either end
  of its range (`val < max && val > min`; 6.8 accepts the ends), e.g. a margin
  of 0 or a max scale of 1. Release notes should say so (9.2).
* **Expo** (`js/ui/expoThumbnail.js`): its own grid per monitor (spacing 14),
  also in stacking order. `overviewModeOff()` animates back to the actor's real
  position. Clones are positioned by the window actor, which includes invisible
  borders.

### 6.1 Cinnamon 6.2 to 6.8

Tested against the latest release of each series (November 2026): 6.0.5,
6.2.10, 6.4.14, 6.6.9, 6.8.0.

* **6.0 to 6.6** share the extension loader (`createExports()`, providing
  `require()`) and the object-style `WorkspaceMonitor`.
* **6.8:**
  * Extensions load through GJS's native importer: top-level `var` and
    `function` declarations are the exports; local files are reached through
    `getCurrentExtension().imports`. `require()` still works through a shim but
    logs a deprecation warning, so the extension uses it only on 6.0-6.6.
  * `WorkspaceMonitor` is a GObject class; the replaced methods are ordinary
    prototype methods with unchanged names and slot format.
  * `_computeWindowLayout()` no longer rounds positions down (on 6.0-6.6
    thumbnails can land up to 1 px off).
  * `prepareOverviewGesture()` (touchpad) also calls `_computeAllWindowSlots()`;
    not covered by a test.
* `cinnamon-version` in `metadata.json` holds minimum versions, so "6.0" alone
  would do; it lists every tested series so readers see what is tested.

### 6.2 Measured on the target system

* Decorations: top 14, bottom 36, left 14, right 14 px; with the default gap of
  4 px, 32 px between thumbnails side by side and 54 px one above the other.
  Hence the small Show all windows defaults (margin 8, gap 4).
* Minimized windows report their normal frame.
* First computation, optimizer, Show all windows (Ryzen 9 5900X): 1 window
  0.2-0.5 ms, 8 windows 4.3-4.9 ms, 20 windows 8.8-10.5 ms; cache hits about
  0.2 ms. The first layout of each opening takes 5-7 ms longer, whichever
  workspace it is: a cost in Cinnamon, not pursued.
* Show all workspaces varies far more (8 windows 2.9-20.9 ms) for the same
  engine work; the fastest runs match Scale's, so the rest is Cinnamon's while
  the view animates. Not pursued.
* With margins at 0, no title or close button is cut off at the screen edge.


## 7. Testing

`node tests/run-all.js` (Mint: `sudo apt install nodejs`) runs about 170 checks
in a few seconds. `node tests/run-versions.js` runs them against the latest of
each series from 6.0 to 6.8, or against given versions (`... 6.8.1 6.8.2`).

* `engine.test.js`: the guarantees for every algorithm, at the defaults and at
  the ends of the ranges on odd monitors; refused input; the safeguard; cache;
  the grid assignment against brute force; regressions from section 5.
* `schema.test.js`: the schema equals the generator's output and the engine's
  defaults; the extension reads exactly these settings; widget types and
  `metadata.json` as Cinnamon expects.
* `extension.test.js`: the extension against Cinnamon's real code, loaded with
  that version's real loader. For Show all windows it builds `WorkspaceMonitor`
  from the real methods in `workspace.js` and lets Cinnamon's own
  `_computeWindowLayout` place the thumbnails. For Show all workspaces it runs
  Cinnamon's `overviewModeOn()` side by side with the replacement on identical
  simulated windows (two monitors, invisible borders, minimized, dragged), and
  fingerprints Cinnamon's method (`KNOWN_EXPO`). Checks: exact placement, no
  colliding decorations or titles, independence from stacking and minimizing,
  caching, switched off equals Cinnamon, fallback on errors, keyboard
  navigation, diagnostics, enable/disable.
* `lab.test.js`: the lab in a simulated browser (needs `jsdom`; skipped
  otherwise).
* `spices.test.js`: the Spices build has exactly the extension's tracked files,
  refuses uncommitted ones (tried on a temporary clone), works from an unpacked
  ZIP, and passes Spices' own `validate-spice` (needs python3 with PIL, Mint:
  `python3-pil`; skipped otherwise).

Cinnamon sources come from `/usr/share/cinnamon` if installed (unless
`CINNAMON_SOURCE=download`), otherwise the version from `cinnamon --version`
(or `CINNAMON_VERSION`, default 6.0.5) is downloaded into
`tests/.cinnamon-src/`.

**Checking a new Cinnamon version:** run `node tests/run-versions.js <version>`
(or `node tests/run-all.js` on the upgraded system). If it fails, compare that
version's `js/ui/workspace.js` (the `WorkspaceMonitor` methods listed at the
top of `tests/extension.test.js`), `js/ui/expoThumbnail.js` and the extension
loader (`js/misc/fileUtils.js`, `js/ui/extension.js`) with the last version
that passed. A changed `overviewModeOn()` fails the fingerprint test: review
`expoOverviewModeOn()`, then add the new fingerprint to `KNOWN_EXPO`. A new
loader needs a matching branch in `makeLoader()`.

Not testable here: a real Cinnamon session (rendering, animation, input).


## 8. Open items

* **Stability between invocations** (keep thumbnails where they were when only
  one window changed): would need the previous layout as an extra starting
  point; not started.
* **Future Cinnamon versions:** see section 7. The `require()` fallback can go
  once 6.0-6.6 are no longer used.


## 9. Publishing

Users get the extension from Cinnamon Spices, through Cinnamon's own Extensions
dialog (Download tab). GitHub holds the source; a release is a merged pull
request to the Spices repository (no GitHub Releases).

* **Version:** `version` in `metadata.json`, for people (Cinnamon notices
  updates by itself). Raise it for each release and tag that commit
  `v<version>`.
* **Package:** `node tools/build-spices.js` builds `dist/spices/<UUID>/`:
  `info.json` and a Spices README from `tools/spices/`, `screenshot.png` from
  `docs/`, and `files/<UUID>/` = the extension folder, checked against Spices'
  rules. In a git clone it takes only committed files and refuses uncommitted
  ones in the extension folder.
* `info.json`'s `author` must be the GitHub account that opens the pull
  requests; Spices reviews the author's own pull requests more lightly. (A
  handover changes `author` and adds `original_author`.)
* The Spices README may link to the repository only for bug reports and
  development: Spices forbids pointing users to downloads elsewhere.
* Icon: render `docs/icon.svg` to the extension's `icon.png` at 256×256.
* License: MIT, also inside the extension folder, since the Spices
  repository's default is GPL 2.

### 9.1 One-time setup for Spices

1. Open `https://github.com/linuxmint/cinnamon-spices-extensions` (the
   original) and click **Fork**. That creates your copy,
   `soren-kragh/cinnamon-spices-extensions`. You can only push to your copy;
   the original's URL is only for this step and for `upstream` below.
2. Clone **your fork** next to this repository (from this repository's
   folder) and connect it to the original. The two URLs differ only in the
   account name:

   ```
   cd ..
   git clone https://github.com/soren-kragh/cinnamon-spices-extensions.git
   cd cinnamon-spices-extensions
   git remote add upstream \
     https://github.com/linuxmint/cinnamon-spices-extensions.git
   ```

   If `git clone` says the folder already exists, an older clone is in the way:
   check it with `git remote -v`, and if it isn't a clone of your fork (or
   holds nothing you need), delete it and run the commands again.
3. Check with `git remote -v`: `origin` must name `soren-kragh` (you push
   there), `upstream` must name `linuxmint` (you only pull from it).
4. Read the rules once: the repository's `README.md` and
   `.github/CONTRIBUTING.md`, and, since this code was written with AI help,
   `.github/copilot-instructions.md` (the reviewers' checklist for AI-assisted
   code).

### 9.2 Making a release

In this repository:

1. Commit everything; `node tests/run-all.js` must pass.
2. Raise `version` in `metadata.json` (the first release keeps 1.0), commit,
   then tag and push:

   ```
   git tag v1.0
   git push
   git push --tags
   ```

3. Build: `node tools/build-spices.js`.

In the clone of your fork (`cd ../cinnamon-spices-extensions`):

4. Update it and start a branch for this release:

   ```
   git checkout master
   git pull upstream master
   git checkout -b window-spread-1.0
   ```

5. Replace the extension's folder with the build and check it
   (`validate-spice` needs `python3-pil`):

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
   `"window-spread@soren-kragh: 1.1, faster layouts"`. A 403 error here means
   `origin` is the original, not your fork (9.1 step 3).
7. On GitHub, your fork offers **Compare & pull request** for the branch (or
   use **New pull request** in its Pull requests tab). Check that it goes to
   `linuxmint/cinnamon-spices-extensions`, branch `master`, use the commit
   message as the title, describe the release in a few lines, and create it.
   If `settings-schema.json` changed since the last release, mention that on
   Cinnamon 6.0-6.6 settings left at either end of their range return to their
   defaults (section 6).
8. Follow the pull request's page: Spices' automatic check runs first, and
   reviewers comment there (GitHub also emails you). To make changes, see
   below; the pull request updates by itself.
9. Once merged, the release is on Spices and users get the update. Delete the
   branch (GitHub offers a button on the pull request).

**Changes after tagging** (before the pull request or during review), so the
tag stays on what users get:

1. Here: fix, commit, run the tests, move the tag and rebuild:

   ```
   git tag -f v1.0
   git push
   git push -f origin v1.0
   node tools/build-spices.js
   ```

2. In the fork's clone, on the release branch (`git checkout
   window-spread-1.0`), repeat step 5, then add the folder and commit:
   * before the pull request exists, replace the commit:
     `git commit --amend --no-edit`, then `git push --force-with-lease`
     (`git push -u origin window-spread-1.0` if the branch was never pushed);
   * during review, add a commit, e.g.
     `git commit -m "window-spread@soren-kragh: Address review"`, then
     `git push`.

### 9.3 After the first release

* Change the GitHub README's Install section to recommend System Settings →
  Extensions → Download, keeping the git steps for the development version.
* Spices users report bugs as issues in the Spices repository, titled
  `window-spread@soren-kragh: ...` and mentioning you.


## 10. Workflow for changes

1. Change the engine and try it in the lab (it loads the same file).
2. Changed a default or a setting's label, range or page? Edit `DEFAULTS` or
   `tools/build-schema.js`, then run `node tools/build-schema.js`.
3. Run `node tests/run-all.js`.
4. Install the copy as in README's "Updating" and restart Cinnamon (Alt+F2,
   `r`). If defaults changed, choose **Reset to defaults** in the settings
   window's menu.
5. Record new decisions and evidence in section 5.
6. To publish: section 9.2.
