// Tests the extension against Cinnamon's real code. Run alone with: node tests/extension.test.js
//
// Real Cinnamon code used (from /usr/share/cinnamon, or downloaded; see lib/cinnamon.js):
//   extension loading   Cinnamon 6.0-6.6: createExports() and findModuleIndex() from js/misc/fileUtils.js
//                       Cinnamon 6.8+:    the require() shim, module/exports handling and
//                       getCurrentExtension() from js/ui/extension.js (GJS's native importer itself
//                       is simulated: it exports top-level var and function declarations)
//   js/ui/workspace.js       the Scale view's WorkspaceMonitor methods the extension builds on:
//                            _getSlotGeometry, _computeWindowLayout, _computeAllWindowSlots,
//                            selectAnotherWindow, selectIndex (object-style or class-style)
//   js/misc/gridNavigator.js Cinnamon's keyboard grid navigation
//   js/ui/main.js            workspace naming (getWorkspaceName)
//   js/ui/expoThumbnail.js   Show all workspaces: the real ExpoWorkspaceThumbnail.overviewModeOn(), run
//                            side by side with the extension's replacement on identical windows
// Simulated (they need a running desktop): windows, the settings store, logging, file reading.
const fs = require('fs'), path = require('path');
const { section, ok, note } = require('./lib/check');
const { cinnamonSources } = require('./lib/cinnamon');
const EXT = path.join(__dirname, '..', 'extension', 'window-spread@soren-kragh');

// Source of a function or method as a function expression. Understands top-level
// `function name(...) {...}`, object-style `name: function(...) {...}` (Cinnamon 6.0-6.6)
// and class-style `name(...) {...}` (Cinnamon 6.8).
function extractFunction(src, name) {
  const patterns = [new RegExp('\\nfunction ' + name + '\\s*\\('), new RegExp('\\n    ' + name + '\\s*:\\s*function\\s*\\('), new RegExp('\\n    ' + name + '\\s*\\(')];
  let m = null, classStyle = false;
  for (let k = 0; k < patterns.length && !m; k++) { m = patterns[k].exec(src); classStyle = k === 2; }
  if (!m) throw new Error('not found in Cinnamon source: ' + name);
  const begin = m.index + 1;
  // skip the parameter list first: it may contain braces itself (destructuring)
  let i = src.indexOf('(', begin), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')') { depth--; if (!depth) break; } }
  i = src.indexOf('{', i); depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) break; } }
  const text = src.slice(begin, i + 1).trim();
  return classStyle ? 'function ' + text : text.slice(text.indexOf('function'));
}

// The extension loader of the Cinnamon version under test, built from its real code.
function makeLoader(read, imports, cinGlobal) {
  const fu = read('js/misc/fileUtils.js'), ex = read('js/ui/extension.js');
  if (fu.indexOf('function createExports(') >= 0) {
    // Cinnamon 6.0-6.6: files run inside createExports()'s wrapper, which provides require().
    const importNames = new Function('return ' + /var importNames = (\[[\s\S]*?\]);/.exec(fu)[1])();
    const cinnamonImportNames = new Function('return ' + /var cinnamonImportNames = (\[[\s\S]*?\]);/.exec(fu)[1])();
    // At runtime this is the list of loaded GObject introspection namespaces; a typical set:
    const giImportNames = ['GLib', 'GObject', 'Gio', 'Clutter', 'Cogl', 'Meta', 'St', 'Cinnamon', 'Gtk', 'Gdk', 'Pango', 'GIRepository', 'CinnamonDesktop'];
    const FunctionConstructor = Symbol(), Symbols = {}; Symbols[FunctionConstructor] = Function;
    let requireModule;
    const createExports = new Function('LoadedModules', 'importNames', 'giImportNames', 'Symbols', 'FunctionConstructor', 'requireModuleRef',
      'var requireModule = function () { return requireModuleRef().apply(null, arguments); };\n' +
      'var findModuleIndex = ' + extractFunction(fu, 'findModuleIndex') + ';\nvar createExports = ' + extractFunction(fu, 'createExports') + ';\nreturn createExports;')(
      [], importNames, giImportNames, Symbols, FunctionConstructor, () => requireModule);
    // Same path rules as fileUtils.requireModule, reading files with Node instead of Gio.
    requireModule = function (p, dir, meta, type) {
      if (p.substr(0, 3) === 'gi.') return imports.gi[p.substr(3)];
      const prefix = p.split('.')[0];
      if (cinnamonImportNames.indexOf(prefix) > -1 && p.substr(0, prefix.length + 1) === prefix + '.') return imports[prefix][p.substr(prefix.length + 1)];
      if (p.substr(-3) !== '.js') p += '.js';
      if (p[0] === '.' || p[0] !== '/') { p = p.replace(/\.\//g, ''); if (dir) p = dir + '/' + p; }
      const JS = fs.readFileSync(p, 'utf8');
      return createExports({ path: p, dir, meta, type, file: { get_basename: () => path.basename(p) }, size: JS.length, JS, returnIndex: false });
    };
    imports.ui.extension = {}; // Cinnamon's own module, without getCurrentExtension() in these versions
    return { kind: 'require() wrapper (Cinnamon 6.0-6.6 style)', modern: false,
      loadExtension: (dir, meta) => requireModule(path.join(dir, 'extension.js'), dir, meta, 'extension') };
  }
  if (ex.indexOf('function _requireLocal(') >= 0) {
    // Cinnamon 6.8+: GJS's native importer loads the files (simulated here: it evaluates a file
    // and exposes its top-level var and function declarations); Cinnamon's real require() shim,
    // module/exports globals and getCurrentExtension() are taken from extension.js.
    const getters = ex.slice(ex.indexOf("Object.defineProperty(globalThis, 'module'"), ex.indexOf('function getXletFromStack'));
    const env = new Function('Gio', 'ByteArray', 'imports', 'global',
      'var currentlyLoadingExtension = null; var requireWarned = new Set(); var moduleStack = []; var moduleExportsCache = {};\n' +
      'var _FunctionConstructor = (0).constructor.constructor;\nfunction getExtension() { return null; }\n' + getters + '\n' +
      ['getXletFromStack', 'getCurrentExtension', '_evalModule', '_requireLocal', 'xletRequire'].map(f => 'var ' + f + ' = ' + extractFunction(ex, f) + ';').join('\n') +
      '\nreturn { setLoading: function (e) { currentlyLoadingExtension = e; }, getCurrentExtension: getCurrentExtension, xletRequire: xletRequire };')(
      { File: { new_for_path: p => ({ load_contents: () => [true, fs.readFileSync(p)] }) } }, { toString: b => b.toString() }, imports, cinGlobal);
    globalThis.require = env.xletRequire; // as Cinnamon does: globalThis.require = xletRequire
    imports.ui.extension = { getCurrentExtension: env.getCurrentExtension };
    function nativeImporter(dir) {
      const cache = {};
      return new Proxy({}, { get: (t, name) => {
        if (typeof name !== 'string') return undefined;
        if (name in cache) return cache[name];
        const file = path.join(dir, name + '.js');
        if (!fs.existsSync(file)) return undefined;
        const src = fs.readFileSync(file, 'utf8'), names = [], re = /^(?:var|function)\s+([a-zA-Z_$][\w$]*)/gm; let m;
        while ((m = re.exec(src))) names.push(m[1]);
        cache[name] = new Function(src + '\n;return {' + names.map(n => JSON.stringify(n) + ': typeof ' + n + " !== 'undefined' ? " + n + ' : undefined').join(', ') + '};')();
        return cache[name];
      } });
    }
    return { kind: 'native importer with require() shim (Cinnamon 6.8 style)', modern: true,
      loadExtension: (dir, meta) => {
        const extension = { uuid: meta.uuid, meta, imports: nativeImporter(dir) };
        env.setLoading(extension); // as Cinnamon does around this.imports[this.lowerType]
        try { return extension.imports.extension; } finally { env.setLoading(null); }
      } };
  }
  throw new Error('unknown extension loader in this Cinnamon version');
}

// Cinnamon provides `global` (logging) and `imports` as globals; the test sets stand-ins and
// restores Node's own afterwards, so later tests (e.g. the lab test) are unaffected.
async function run() {
  const saved = {};
  for (const k of ['global', 'imports', 'require', 'module', 'exports']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  try { await runChecks(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k];
    }
  }
}

async function runChecks() {
  section('Cinnamon integration: setup');
  const C = await cinnamonSources();
  note('Cinnamon code from: ' + C.origin);
  note(C.matches605 ? 'files identical to Cinnamon 6.0.5, the version the extension was first written against'
    : 'files differ from Cinnamon 6.0.5 (the version the extension was first written against); the checks below show whether it still fits');
  const read = p => fs.readFileSync(C.path(p), 'utf8');

  const logs = [];
  const cinGlobal = { log: m => logs.push(['log', m]), logError: m => logs.push(['error', m]), logWarning: m => logs.push(['warning', m]) };
  const imports = { ui: {}, gi: {}, misc: {} };
  global.imports = imports; global.global = cinGlobal;
  const loader = makeLoader(read, imports, cinGlobal);
  note('extension loader: ' + loader.kind);

  // --- Scale view: WorkspaceMonitor built from the real methods ---
  const Clutter = { KEY_Home: 0xff50, KEY_Left: 0xff51, KEY_Up: 0xff52, KEY_Right: 0xff53, KEY_Down: 0xff54, KEY_End: 0xff57,
    AnimationMode: { EASE_OUT_QUAD: 'EASE_OUT_QUAD' } };
  const GridNavigator = new Function('imports', read('js/misc/gridNavigator.js') + ';return { nextIndex: nextIndex };')({ gi: { Clutter } });
  const ws = read('js/ui/workspace.js');
  const DEFAULT_SLOT_FRACTION = Number(/const DEFAULT_SLOT_FRACTION = ([\d.]+);/.exec(ws)[1]);
  function WorkspaceMonitor() {}
  for (const name of ['_getSlotGeometry', '_computeWindowLayout', '_computeAllWindowSlots', 'selectAnotherWindow', 'selectIndex'])
    WorkspaceMonitor.prototype[name] = new Function('DEFAULT_SLOT_FRACTION', 'GridNavigator', 'return (' + extractFunction(ws, name) + ')')(DEFAULT_SLOT_FRACTION, GridNavigator);
  const P = WorkspaceMonitor.prototype, original = { slots: P._computeAllWindowSlots, select: P.selectAnotherWindow };

  // --- workspace naming from main.js ---
  const mainSrc = read('js/ui/main.js'), workspace_names = ['', 'Mail'];
  const Main = new Function('workspace_names', '_', 'var _makeDefaultWorkspaceName = ' + extractFunction(mainSrc, '_makeDefaultWorkspaceName') + ';\n' +
    'var getWorkspaceName = ' + extractFunction(mainSrc, 'getWorkspaceName') + ';\nreturn { getWorkspaceName: getWorkspaceName };')(workspace_names, s => s);

  // --- Show all workspaces: ExpoWorkspaceThumbnail with Cinnamon's real overviewModeOn ---
  const MONITORS = [{ x: 0, y: 0, width: 2560, height: 1440 }, { x: 2560, y: 0, width: 1920, height: 1080 }];
  Object.assign(Main, { layoutManager: { monitors: MONITORS }, animations_enabled: true });
  const exSrc = read('js/ui/expoThumbnail.js');
  const expoConst = name => Number(new RegExp('const ' + name + ' = (-?[\\d.]+);').exec(exSrc)[1]);
  const separateActor = exSrc.indexOf('window.actor.ease') >= 0;                       // Cinnamon 6.0-6.6
  const boxScaleName = exSrc.indexOf('box.thumbnail_scale') >= 0 ? 'thumbnail_scale' : 'scale'; // 6.8: thumbnail_scale
  function ExpoWorkspaceThumbnail() {}
  ExpoWorkspaceThumbnail.prototype.overviewModeOn = new Function('Main', 'Clutter', 'REARRANGE_TIME_ON', 'ICON_OFFSET',
    'return (' + extractFunction(exSrc, 'overviewModeOn') + ')')(Main, Clutter, expoConst('REARRANGE_TIME_ON'), expoConst('ICON_OFFSET'));
  const expoOriginal = ExpoWorkspaceThumbnail.prototype.overviewModeOn;

  // --- simulated settings store (values start at the schema defaults, as in Cinnamon) ---
  const schema = JSON.parse(fs.readFileSync(path.join(EXT, 'settings-schema.json'), 'utf8'));
  const instances = [];
  function ExtensionSettings(obj, uuid) {
    this.uuid = uuid; this.settingsData = {};
    for (const k of Object.keys(schema)) if ('default' in schema[k]) this.settingsData[k] = Object.assign({}, schema[k], { value: schema[k].default });
    instances.push(this);
  }
  ExtensionSettings.prototype.getValue = function (k) { if (!(k in this.settingsData)) throw new Error('unknown key ' + k); return this.settingsData[k].value; };
  ExtensionSettings.prototype.setValue = function (k, v) { if (!(k in this.settingsData)) throw new Error('unknown key ' + k); this.settingsData[k].value = v; };
  ExtensionSettings.prototype.finalize = function () { this.finalized = true; };
  const settingsNow = () => instances[instances.length - 1];

  Object.assign(imports.ui, { main: Main, workspace: { WorkspaceMonitor }, settings: { ExtensionSettings }, expoThumbnail: { ExpoWorkspaceThumbnail } });
  Object.assign(imports.gi, { Clutter, GLib: { get_monotonic_time: () => Math.round(Number(process.hrtime.bigint()) / 1000) } });

  // --- fake monitors and windows ---
  const CHROME = { top: 14, bottom: 36, left: 14, right: 14 }; // measured on the target system
  function monitor(frames, ws) {
    const mon = new WorkspaceMonitor();
    Object.assign(mon, { _x: 0, _y: 0, _width: 2560, _height: 1440, _margin: 2560 * 0.01, _slotWidth: 0, monitorIndex: 0, _kbWindowIndex: 0,
      metaWorkspace: { index: () => (ws === undefined ? 1 : ws) }, _myWorkspace: { selectActiveClone: c => { mon._selected = c; } } });
    const overlay = { chromeHeights: () => [CHROME.top, CHROME.bottom], chromeWidths: () => [CHROME.left, CHROME.right] };
    mon._windows = frames.map(f => ({ overlay, metaWindow: { _f: f, minimized: !!f.min, get_title: () => 'win' + f.seq,
      get_frame_rect: () => ({ x: f.x, y: f.y, width: f.w, height: f.h }), get_stable_sequence: () => f.seq } }));
    return mon;
  }
  const frames = [{ seq: 11, x: 100, y: 80, w: 1400, h: 1000 }, { seq: 12, x: 900, y: 160, w: 1200, h: 900 }, { seq: 13, x: 1900, y: 100, w: 560, h: 850, min: true },
    { seq: 14, x: 260, y: 700, w: 850, h: 600 }, { seq: 15, x: 1500, y: 780, w: 900, h: 560 }, { seq: 16, x: 2100, y: 870, w: 350, h: 480 }];
  const n = frames.length;
  const place = (mon, slots) => mon._windows.map((c, i) => {
    const r = P._computeWindowLayout.call(mon, c.metaWindow, slots[i]), f = c.metaWindow._f;
    return { seq: f.seq, x: r[0], y: r[1], w: f.w * r[2], h: f.h * r[2], scale: r[2] };
  });

  section('Cinnamon integration: loading and enabling');
  const ext = loader.loadExtension(EXT, { uuid: 'window-spread@soren-kragh', path: EXT });
  ok('Cinnamon\'s loader finds init, enable and disable', ['init', 'enable', 'disable'].every(f => typeof ext[f] === 'function'));
  if (loader.modern) ok('the engine is loaded the modern way (no deprecation warning)', !logs.some(l => l[0] === 'warning' && /deprecated/.test(l[1])));
  ext.init({ uuid: 'window-spread@soren-kragh', path: EXT });
  const callbacks = ext.enable();
  ok('enable() replaces the two WorkspaceMonitor methods', P._computeAllWindowSlots !== original.slots && P.selectAnotherWindow !== original.select);

  section('Cinnamon integration: layout');
  const mon = monitor(frames), slots = P._computeAllWindowSlots.call(mon, n);
  ok('one slot per window', Array.isArray(slots) && slots.length === n);
  const placed = place(mon, slots);
  // the engine's own answer for the same input, with the same settings the extension builds
  const SL = require(path.join(EXT, 'spreadLayout.js'));
  const d = k => schema[k].default;
  const S = SL.settings('anneal', { margin: d('margin'), spacing: d('spacing') + Math.max(CHROME.top + CHROME.bottom, CHROME.left + CHROME.right),
    fidelity: d('fidelity'), maxScale: Math.min(1, d('max-scale')), centered: d('centered'), fill: d('fill'), growLimit: d('grow-limit'),
    wScale: d('w-scale'), wDisp: d('w-disp'), wRel: d('w-rel'), relMode: d('rel-mode'), relNear: d('rel-near'),
    iterations: d('anneal-effort') * 1000, restarts: d('anneal-restarts'), checkpoint: d('anneal-checkpoint'), temp: d('anneal-temp'),
    startFrom: d('anneal-start-from'), seed: d('anneal-seed'), bailout: d('anneal-bailout'), polish: d('anneal-polish'),
    pushStart: { iterations: d('natural-iterations'), step: d('natural-step'), aspect: d('natural-aspect'), polish: d('natural-polish') },
    rowsStart: { rows: d('rows-count') } });
  const area = { x: CHROME.left, y: CHROME.top, w: 2560 - CHROME.left - CHROME.right, h: 1440 - CHROME.top - CHROME.bottom };
  const want = SL.compute(frames.map(f => ({ id: f.seq, x: f.x, y: f.y, w: f.w, h: f.h })), area, 'anneal', S).targets;
  let maxErr = 0;
  for (const p of placed) { const t = want.filter(t => t.id === p.seq)[0]; maxErr = Math.max(maxErr, Math.abs(p.x - t.x), Math.abs(p.y - t.y), Math.abs(p.w - t.w), Math.abs(p.h - t.h)); }
  ok('Cinnamon\'s own fitting code puts each thumbnail where the engine says', maxErr < 1.001,
    'max deviation ' + maxErr.toFixed(2) + ' px' + (maxErr > 0.01 ? '; this Cinnamon version rounds positions down to whole pixels' : ''));
  const boxes = placed.map(p => ({ x1: p.x - CHROME.left, y1: p.y - CHROME.top, x2: p.x + p.w + CHROME.right, y2: p.y + p.h + CHROME.bottom }));
  let clash = 0, off = 0;
  for (const b of boxes) { if (b.x1 < -0.5 || b.y1 < -0.5 || b.x2 > 2560.5 || b.y2 > 1440.5) off++; for (const c of boxes) if (b !== c && b.x1 < c.x2 && c.x1 < b.x2 && b.y1 < c.y2 && c.y1 < b.y2) clash++; }
  ok('thumbnails with their titles and close buttons never overlap and stay on screen', !clash && !off);
  ok('a minimized window is laid out like the others', placed.filter(p => p.seq === 13)[0].scale > 0);
  const mon2 = monitor(frames.slice().reverse()), placed2 = place(mon2, P._computeAllWindowSlots.call(mon2, n));
  ok('another stacking order gives every window the same place', placed2.every(p => { const q = placed.filter(q => q.seq === p.seq)[0]; return q.x === p.x && q.y === p.y; }));
  ok('window title width limited to the smallest thumbnail plus the gap', mon._slotWidth === Math.floor(Math.min.apply(null, want.map(t => t.w)) + S.spacing), mon._slotWidth + ' px');
  for (const alg of ['natural', 'rows', 'grid']) {
    settingsNow().setValue('algorithm', alg); logs.length = 0;
    const s = P._computeAllWindowSlots.call(monitor(frames), n);
    ok('algorithm "' + alg + '" works', s.length === n && !logs.some(l => l[0] === 'error'));
  }
  settingsNow().setValue('algorithm', 'anneal');

  section('Cinnamon integration: cache and diagnostics');
  settingsNow().setValue('debug-log', true);
  P._computeAllWindowSlots.call(monitor(frames), n);                       // opening: computes
  logs.length = 0;
  P._computeAllWindowSlots.call(monitor(frames.slice().reverse()), n);     // reopening, other stacking
  ok('reopening (even with another stacking order) reuses the cached layout', logs.some(l => l[1].indexOf('reused cached layout') >= 0));
  P._computeAllWindowSlots.call(monitor(frames, 3), n); logs.length = 0; P._computeAllWindowSlots.call(monitor(frames, 1), n);
  ok('each workspace keeps its own cached layout', logs.some(l => l[1].indexOf('reused cached layout') >= 0));
  ext.disable(); ext.enable(); settingsNow().setValue('debug-log', true); logs.length = 0;
  P._computeAllWindowSlots.call(monitor([{ seq: 1, x: 100, y: 100, w: 800, h: 600 }], 0), 1);
  P._computeAllWindowSlots.call(monitor(frames, 1), n);
  ok('log names workspaces by index and visible name', logs.some(l => l[1].indexOf('monitor index 0, workspace index 0 ("Workspace 1")') >= 0) &&
    logs.some(l => l[1].indexOf('monitor index 0, workspace index 1 ("Mail"): 6 windows (1 minimized)') >= 0));
  ok('minimized windows are reported for every workspace', logs.some(l => l[1].indexOf('minimized window "win13": frame 1900,100 560x850') >= 0));
  ok('decorations are reported once per session', logs.filter(l => l[1].indexOf('decorations around thumbnails') >= 0).length === 1);
  // Engine settings not offered in the settings window (e.g. Keep sizes) must still be defined:
  // a missing weight would make the score "not a number". A light desktop with small windows
  // makes thumbnails reach real size, so the size-distortion term is actually in play.
  logs.length = 0;
  P._computeAllWindowSlots.call(monitor([{ seq: 71, x: 300, y: 200, w: 420, h: 300 }, { seq: 72, x: 1500, y: 700, w: 360, h: 260 }, { seq: 73, x: 900, y: 400, w: 1200, h: 800 }], 14), 3);
  const scoreLine = logs.filter(l => /workspace index 14 .*score/.test(l[1]))[0];
  ok('the score is a valid number, so every engine setting is defined', !!scoreLine && /score \d+\.\d+$/.test(scoreLine[1]), scoreLine ? scoreLine[1].replace(/^.*score/, 'score') : 'no log line');
  settingsNow().setValue('debug-log', false);

  section('Cinnamon integration: keyboard navigation');
  const kb = monitor(frames), kbPlaced = place(kb, P._computeAllWindowSlots.call(kb, n));
  const centers = kbPlaced.map(p => [p.x + p.w / 2, p.y + p.h / 2]);
  const leftmost = centers.reduce((b, c, i) => (c[0] < centers[b][0] ? i : b), 0);
  kb._kbWindowIndex = leftmost;
  const moved = P.selectAnotherWindow.call(kb, Clutter.KEY_Right);
  ok('Right arrow moves to a thumbnail to the right', moved === true && centers[kb._windows.indexOf(kb._selected)][0] > centers[leftmost][0]);
  kb._kbWindowIndex = leftmost;
  ok('Left arrow from the leftmost thumbnail is not handled (as in Cinnamon)', P.selectAnotherWindow.call(kb, Clutter.KEY_Left) === false);
  ok('Home key is still handled by Cinnamon\'s own navigation', P.selectAnotherWindow.call(kb, Clutter.KEY_Home) === true);

  section('Cinnamon integration: safety');
  const bad = monitor(frames); bad._windows[2].metaWindow.get_frame_rect = () => { throw new Error('simulated failure'); }; logs.length = 0;
  ok('an error falls back to Cinnamon\'s grid and is logged',
    JSON.stringify(P._computeAllWindowSlots.call(bad, n)) === JSON.stringify(original.slots.call(bad, n)) && logs.some(l => l[0] === 'error'));
  ok('a workspace without windows', JSON.stringify(P._computeAllWindowSlots.call(monitor([]), 0)) === '[]');

  section('Cinnamon integration: settings dialog button');
  ok('enable() returns the function the "Restore defaults" button names', callbacks && typeof callbacks[schema['restore-defaults'].callback] === 'function');
  const st = settingsNow();
  st.setValue('margin', 100); st.setValue('w-scale', 1.5); st.setValue('algorithm', 'rows'); st.setValue('rel-mode', 'order'); st.setValue('fill', true);
  callbacks[schema['restore-defaults'].callback].call(callbacks);
  ok('pressing it restores every setting to its default', Object.keys(st.settingsData).every(k => st.settingsData[k].value === st.settingsData[k].default),
    'margin ' + st.getValue('margin') + ', thumbnail size ' + st.getValue('w-scale') + ', algorithm ' + st.getValue('algorithm'));

  // ---------------------------------------------------------------- Show all workspaces (Expo)
  section('Cinnamon integration: Show all workspaces (Expo)');
  const E = ExpoWorkspaceThumbnail.prototype;
  ok('enable() replaces ExpoWorkspaceThumbnail.overviewModeOn', E.overviewModeOn !== expoOriginal);
  // The extension mirrors Cinnamon's method; flag any change to Cinnamon's version.
  const normalized = extractFunction(exSrc, 'overviewModeOn').replace(/this\.box\.(thumbnail_scale|scale)/g, 'BOXSCALE')
    .replace(/window\.actor\./g, 'window.').replace(/^function\s*(overviewModeOn)?\s*/, '').replace(/\s+/g, '');
  const fingerprint = require('crypto').createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  const KNOWN_EXPO = ['60a9f5ca952291f1']; // Cinnamon 6.0.5 to 6.8.0 (identical logic once the renamed fields are normalized)
  ok('Cinnamon\'s Expo arrangement code is a known version (the extension mirrors it)', KNOWN_EXPO.indexOf(fingerprint) >= 0,
    'fingerprint ' + fingerprint + (KNOWN_EXPO.indexOf(fingerprint) >= 0 ? '' : ': Cinnamon changed overviewModeOn(); review expoOverviewModeOn() in extension.js'));
  const extSrc = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8'), extConst = n => Number(new RegExp('const ' + n + ' = (-?[\\d.]+);').exec(extSrc)[1]);
  ok('the extension\'s copies of Cinnamon\'s Expo constants match this Cinnamon version',
    extConst('EXPO_REARRANGE_TIME_ON') === expoConst('REARRANGE_TIME_ON') && extConst('EXPO_ICON_OFFSET') === expoConst('ICON_OFFSET') &&
    new RegExp('let iconScale = \\(' + extConst('EXPO_ICON_SCALE') + '/').test(exSrc));

  // Simulated windows: visible frames inside window actors with invisible borders of different
  // kinds, as real windows have: none, typical 10 px resize borders, and wide, uneven shadows
  // drawn by the application itself (GTK apps); animations complete immediately.
  const NONE = { l: 0, t: 0, r: 0, b: 0 }, SHADOW = { l: 26, t: 23, r: 26, b: 29 }, WIDE = { l: 48, t: 40, r: 48, b: 56 };
  const EXPO_SPECS = [
    { seq: 1, x: 80, y: 60, w: 1300, h: 900, border: NONE }, { seq: 2, x: 900, y: 140, w: 1200, h: 850, border: SHADOW },
    { seq: 3, x: 1900, y: 100, w: 560, h: 800, min: true, border: WIDE }, { seq: 4, x: 240, y: 700, w: 900, h: 640, border: WIDE },
    { seq: 5, x: 1500, y: 760, w: 950, h: 600, border: SHADOW }, { seq: 6, x: 1300, y: 500, w: 300, h: 240, skip: true },
    { seq: 7, x: 2700, y: 80, w: 1000, h: 700, monitor: 1, border: WIDE }, { seq: 8, x: 3300, y: 400, w: 1100, h: 620, monitor: 1, border: NONE },
    { seq: 9, x: 2900, y: 600, w: 500, h: 400, monitor: 1, border: SHADOW },
    { seq: 10, x: 600, y: 400, w: 700, h: 500, inDrag: true }];
  const BOXSCALE = 0.2, ICON_SIZE = expoConst('ICON_SIZE');
  const borderOf = sp => sp.border || { l: 10, t: 10, r: 10, b: 10 };
  const OVERHANG = -expoConst('ICON_OFFSET') / BOXSCALE; // badge overhang beyond a window's corner, full-size px
  const BADGE = ICON_SIZE * 0.25 / BOXSCALE;              // badge size, full-size px (32 px on screen)
  function makeActor(x, y) {
    return { x, y, scale_x: 1, scale_y: 1, opacity: 255, visible: true, eases: 0,
      ease(p) { this.eases++; for (const k of ['x', 'y', 'scale_x', 'scale_y', 'opacity']) if (k in p) this[k] = p[k]; if (p.onComplete) p.onComplete(); },
      show() { this.visible = true; }, hide() { this.visible = false; } };
  }
  function expoThumb(specs, wsIndex) {
    const windows = specs.map(sp => {
      const b = borderOf(sp), real = { x: sp.x - b.l, y: sp.y - b.t, width: sp.w + b.l + b.r, height: sp.h + b.t + b.b };
      const actor = makeActor(real.x, real.y);
      const w = separateActor ? { actor } : actor;
      return Object.assign(w, { _spec: sp, realWindow: real, inDrag: !!sp.inDrag, refreshed: [], urgency: 0,
        metaWindow: { _skip: !!sp.skip, minimized: !!sp.min, get_title: () => 'win' + sp.seq, get_monitor: () => sp.monitor || 0,
          get_frame_rect: () => ({ x: sp.x, y: sp.y, width: sp.w, height: sp.h }), get_stable_sequence: () => sp.seq },
        icon: { scale: 1, x: 0, y: 0, visible: false, raised: 0, raise_top() { this.raised++; }, set_scale(a) { this.scale = a; },
          set_position(x, y) { this.x = x; this.y = y; }, show() { this.visible = true; }, hide() { this.visible = false; } },
        refreshClone(t) { this.refreshed.push(t); }, showUrgencyState() { this.urgency++; } });
    });
    const thumb = new ExpoWorkspaceThumbnail(), box = {}; box[boxScaleName] = BOXSCALE;
    return Object.assign(thumb, { box, windows, overviewMode: false, resets: 0, resetCloneHover() { this.resets++; },
      isOverviewWindow: mw => !mw._skip, metaWorkspace: { index: () => (wsIndex === undefined ? 2 : wsIndex) } });
  }
  const actorOf = w => w.actor || w;
  // where each window's visible frame ends up on screen
  const frameOnScreen = w => { const a = actorOf(w), sp = w._spec, b = borderOf(sp);
    return { seq: sp.seq, x: a.x + b.l * a.scale_x, y: a.y + b.t * a.scale_y, w: sp.w * a.scale_x, h: sp.h * a.scale_y, scale: a.scale_x }; };
  // where each window's app icon badge ends up, in the same full-size coordinates
  const badgeOf = w => { const a = actorOf(w); return { seq: w._spec.seq, x: a.x + w.icon.x * a.scale_x, y: a.y + w.icon.y * a.scale_y, w: ICON_SIZE * w.icon.scale * a.scale_x, h: ICON_SIZE * w.icon.scale * a.scale_y }; };
  const shownOf = th => th.windows.filter(w => !w._spec.skip && !w._spec.inDrag);
  // Behavior every overview window must have after overviewModeOn (as in Cinnamon's own code)
  function behavior(th) {
    const sh = shownOf(th), hidden = th.windows.filter(w => w._spec.skip)[0], dragged = th.windows.filter(w => w._spec.inDrag)[0];
    return {
      overviewMode: th.overviewMode === true && th.resets === 1,
      hiddenWindow: actorOf(hidden).scale_x === 0 && actorOf(hidden).visible === false,
      draggedUntouched: actorOf(dragged).eases === 0 && dragged.refreshed.length === 0,
      refreshed: sh.every(w => w.refreshed.length === 1 && w.refreshed[0] === true && w.urgency === 1),
      visible: sh.every(w => actorOf(w).visible && actorOf(w).opacity === 255 && w.icon.visible && w.icon.raised === 1),
      iconSize: sh.every(w => Math.abs(w.icon.scale * actorOf(w).scale_x * BOXSCALE - 0.25) < 1e-9),
    };
  }
  // Cinnamon's original, for reference
  const thO = expoThumb(EXPO_SPECS); expoOriginal.call(thO);
  const bO = behavior(thO);
  ok('reference: Cinnamon\'s own overviewModeOn runs in this simulation', Object.keys(bO).every(k => bO[k]), JSON.stringify(bO));
  // The extension's version
  settingsNow().setValue('debug-log', true); logs.length = 0;
  const thN = expoThumb(EXPO_SPECS); E.overviewModeOn.call(thN);
  const bN = behavior(thN);
  for (const k of Object.keys(bO)) ok('same behavior as Cinnamon\'s: ' + {
    overviewMode: 'enters overview mode and resets hover state', hiddenWindow: 'windows that don\'t belong shrink away and hide',
    draggedUntouched: 'a window being dragged is left alone', refreshed: 'clones refreshed (with transients) and urgency shown once',
    visible: 'windows and app icons shown at full opacity after animating', iconSize: 'app icons the same on-screen size for every window' }[k], bN[k] === bO[k] && bN[k]);
  // App icon badges: Cinnamon anchors them to the window actor's corner (which includes invisible
  // borders); the extension anchors them to the visible window's corner, at the same on-screen offset.
  const offsetFrom = (w, ax, ay) => { const bd = badgeOf(w); return [(bd.x - ax) * BOXSCALE, (bd.y - ay) * BOXSCALE]; };
  ok('reference: Cinnamon puts each badge at a fixed offset from the window actor\'s corner',
    shownOf(thO).every(w => { const a = actorOf(w), o = offsetFrom(w, a.x, a.y); return Math.abs(o[0] - expoConst('ICON_OFFSET')) < 1e-9 && Math.abs(o[1] - expoConst('ICON_OFFSET')) < 1e-9; }));
  ok('badges sit at that same offset from the visible window\'s corner, whatever its invisible borders',
    shownOf(thN).every(w => { const f = frameOnScreen(w), o = offsetFrom(w, f.x, f.y); return Math.abs(o[0] - expoConst('ICON_OFFSET')) < 1e-9 && Math.abs(o[1] - expoConst('ICON_OFFSET')) < 1e-9; }),
    'windows without borders, with 10 px borders, and with wide uneven shadows');
  {
    let touches = 0, close = 0, outside = 0;
    MONITORS.forEach((m, mi) => {
      const ws_ = shownOf(thN).filter(w => (w._spec.monitor || 0) === mi), fr = ws_.map(frameOnScreen), bd = ws_.map(badgeOf);
      bd.forEach((b, i) => {
        if (b.x < m.x + d('expo-margin') - 0.5 || b.y < m.y + d('expo-margin') - 0.5) outside++;
        fr.concat(bd).forEach((o, j) => { if (j === i || j === i + fr.length) return;
          const gap = Math.max(o.x - (b.x + b.w), b.x - (o.x + o.w), o.y - (b.y + b.h), b.y - (o.y + o.h));
          if (gap < 0) touches++; else if (gap < d('expo-spacing') - 0.01) close++; });
      });
    });
    ok('no badge touches another window or badge, and every badge keeps at least the Expo gap', !touches && !close, touches + ' touching, ' + close + ' too close');
    ok('badges stay inside the Expo margin', !outside);
  }
  ok('no errors', !logs.some(l => l[0] === 'error'), logs.filter(l => l[0] === 'error').map(l => l[1]).join(' | '));
  // Placement: the engine's layout per monitor, with the Expo settings (default: equal grid, nearest cell)
  const expoS = SL.settings(schema['expo-algorithm'].default, Object.assign({}, S, { margin: d('expo-margin'), spacing: d('expo-spacing') + OVERHANG }));
  let placeErr = 0, offMon = 0, clashE = 0, tight = 0;
  MONITORS.forEach((m, mi) => {
    // a window being dragged keeps its place in the layout (as in Cinnamon) but isn't moved
    const mine = EXPO_SPECS.filter(sp => (sp.monitor || 0) === mi && !sp.skip);
    const want = SL.compute(mine.map(sp => ({ id: sp.seq, x: sp.x, y: sp.y, w: sp.w, h: sp.h })),
      { x: m.x + OVERHANG, y: m.y + OVERHANG, w: m.width - OVERHANG, h: m.height - OVERHANG }, schema['expo-algorithm'].default, expoS).targets;
    const got = shownOf(thN).filter(w => (w._spec.monitor || 0) === mi).map(frameOnScreen);
    for (const g of got) {
      const t = want.filter(t => t.id === g.seq)[0];
      placeErr = Math.max(placeErr, Math.abs(g.x - t.x), Math.abs(g.y - t.y), Math.abs(g.w - t.w), Math.abs(g.h - t.h));
      if (g.x < m.x + expoS.margin + OVERHANG - 0.5 || g.y < m.y + expoS.margin + OVERHANG - 0.5 || g.x + g.w > m.x + m.width - expoS.margin + 0.5 || g.y + g.h > m.y + m.height - expoS.margin + 0.5) offMon++;
      for (const h of got) if (h !== g) {
        const gap = Math.max(h.x - (g.x + g.w), g.x - (h.x + h.w), h.y - (g.y + g.h), g.y - (h.y + h.h));
        if (gap < 0) clashE++; else if (gap < d('expo-spacing') - 0.01) tight++;
      }
    }
  });
  ok('each window\'s visible frame lands exactly where the engine puts it (actor offset for invisible borders handled)', placeErr < 1e-6, 'max deviation ' + placeErr.toExponential(1) + ' px');
  ok('windows stay on their own monitor, inside the Expo margin, without overlaps, with at least the Expo gap', !offMon && !clashE && !tight);
  ok('default Expo algorithm is the equal grid', schema['expo-algorithm'].default === 'grid' && logs.some(l => /^\[window-spread\] expo, .*grid/.test(l[1])));
  // Stacking order never matters
  const thR = expoThumb(EXPO_SPECS.slice().reverse()); E.overviewModeOn.call(thR);
  const posN = JSON.stringify(shownOf(thN).map(frameOnScreen).sort((a, b) => a.seq - b.seq)), posR = JSON.stringify(shownOf(thR).map(frameOnScreen).sort((a, b) => a.seq - b.seq));
  ok('another stacking order gives every window the same place', posN === posR);
  ok('Cinnamon\'s own arrangement, for comparison, does depend on stacking order', (() => {
    const a = expoThumb(EXPO_SPECS), b = expoThumb(EXPO_SPECS.slice().reverse()); expoOriginal.call(a); expoOriginal.call(b);
    return JSON.stringify(shownOf(a).map(frameOnScreen).sort((x, y) => x.seq - y.seq)) !== JSON.stringify(shownOf(b).map(frameOnScreen).sort((x, y) => x.seq - y.seq)); })());
  // Cache: Expo slots, separate from Scale's
  ok('the log names Expo layouts by monitor and workspace', logs.some(l => l[1].indexOf('expo, monitor index 0, workspace index 2 ("Workspace 3"): 6 windows') >= 0) &&
    logs.some(l => l[1].indexOf('expo, monitor index 1, workspace index 2 ("Workspace 3"): 3 windows') >= 0));
  ok('hovering the same workspace again reuses the cached layouts', logs.filter(l => /expo, .*reused cached layout/.test(l[1])).length >= 2);
  logs.length = 0; P._computeAllWindowSlots.call(monitor(frames), n); P._computeAllWindowSlots.call(monitor(frames), n);
  ok('Expo layouts don\'t evict the Show all windows layout of the same workspace', logs.some(l => /^\[window-spread\] monitor index 0, workspace index 1 .*reused cached layout/.test(l[1])));
  // Every algorithm
  for (const alg of ['anneal', 'natural', 'rows', 'grid']) {
    settingsNow().setValue('expo-algorithm', alg); logs.length = 0;
    const th = expoThumb(EXPO_SPECS, 4); E.overviewModeOn.call(th);
    const fr = shownOf(th).map(frameOnScreen);
    let bad = 0; for (const g of fr) for (const h of fr) if (g !== h && g.x < h.x + h.w && h.x < g.x + g.w && g.y < h.y + h.h && h.y < g.y + g.h) bad++;
    ok('Expo algorithm "' + alg + '" works', !bad && !logs.some(l => l[0] === 'error') && Object.values(behavior(th)).every(Boolean));
  }
  settingsNow().setValue('expo-algorithm', 'grid');
  // The two views have independent settings
  { const st = settingsNow(), expoPos = ws => { const th = expoThumb(EXPO_SPECS, ws); E.overviewModeOn.call(th); return JSON.stringify(shownOf(th).map(frameOnScreen)); };
    const scalePos = () => JSON.stringify(place(monitor(frames), P._computeAllWindowSlots.call(monitor(frames), n)));
    st.setValue('algorithm', 'natural'); st.setValue('expo-algorithm', 'natural');
    const expo0 = expoPos(11), scale0 = scalePos();
    st.setValue('fidelity', 0.3);
    const expo1 = expoPos(11), scale1 = scalePos();
    ok('changing Show all windows\' size fidelity changes Show all windows only', scale1 !== scale0 && expo1 === expo0);
    st.setValue('fidelity', d('fidelity')); st.setValue('expo-fidelity', 0.3);
    const expo2 = expoPos(11), scale2 = scalePos();
    ok('changing Show all workspaces\' size fidelity changes Show all workspaces only', expo2 !== expo0 && scale2 === scale0);
    st.setValue('expo-fidelity', d('expo-fidelity')); st.setValue('expo-centered', true);
    const expo3 = expoPos(11);
    ok('Show all workspaces has its own centering setting', expo3 !== expo0 && scalePos() === scale0);
    st.setValue('expo-centered', d('expo-centered')); st.setValue('expo-max-scale', 1.5);
    const th = expoThumb(EXPO_SPECS, 12); E.overviewModeOn.call(th);
    ok('Show all workspaces never shows thumbnails larger than the real window, whatever its max scale says', shownOf(th).every(w => actorOf(w).scale_x <= 1 + 1e-9));
    st.setValue('expo-max-scale', d('expo-max-scale')); st.setValue('algorithm', d('algorithm')); st.setValue('expo-algorithm', d('expo-algorithm')); }

  // Switched off: exactly Cinnamon's own result
  settingsNow().setValue('expo-enabled', false);
  { const a = expoThumb(EXPO_SPECS), b = expoThumb(EXPO_SPECS); expoOriginal.call(a); E.overviewModeOn.call(b);
    ok('with Expo arrangement switched off, the result is exactly Cinnamon\'s', JSON.stringify(shownOf(a).map(frameOnScreen)) === JSON.stringify(shownOf(b).map(frameOnScreen))); }
  settingsNow().setValue('expo-enabled', true);
  // Thumbnail not sized yet: nothing happens, as in Cinnamon
  { const a = expoThumb(EXPO_SPECS); a.box[boxScaleName] = 0; E.overviewModeOn.call(a);
    ok('before the thumbnail has a size, nothing happens (as in Cinnamon)', a.overviewMode === false && a.windows.every(w => actorOf(w).eases === 0)); }
  // Failure: falls back to Cinnamon's own
  { const a = expoThumb(EXPO_SPECS), b = expoThumb(EXPO_SPECS); b.windows[1].metaWindow.get_frame_rect = () => { throw new Error('simulated failure'); };
    expoOriginal.call(a); logs.length = 0; E.overviewModeOn.call(b);
    ok('an error falls back to Cinnamon\'s own Expo arrangement and is logged',
      JSON.stringify(shownOf(a).map(frameOnScreen)) === JSON.stringify(shownOf(b).map(frameOnScreen)) && logs.some(l => l[0] === 'error' && /Expo layout failed/.test(l[1]))); }
  // Edge cases real desktops produce
  { const a = expoThumb(EXPO_SPECS, 6); E.overviewModeOn.call(a); const first = JSON.stringify(shownOf(a).map(frameOnScreen));
    for (const w of a.windows) { w.refreshed = []; w.urgency = 0; w.icon.raised = 0; } a.resets = 0;
    E.overviewModeOn.call(a); E.overviewModeOn.call(a);
    ok('calling it repeatedly (as hovering does) keeps every window in the same place', JSON.stringify(shownOf(a).map(frameOnScreen)) === first); }
  { const only0 = EXPO_SPECS.filter(sp => !sp.monitor); const a = expoThumb(only0, 7); logs.length = 0; E.overviewModeOn.call(a);
    ok('a monitor without windows is skipped quietly', !logs.some(l => l[0] === 'error') && Object.values(behavior(a)).every(Boolean)); }
  { const a = expoThumb([{ seq: 50, x: 100, y: 100, w: 400, h: 300, skip: true }], 8); logs.length = 0; E.overviewModeOn.call(a);
    ok('a workspace whose only window doesn\'t belong: it hides, nothing else happens', !logs.some(l => l[0] === 'error') &&
      actorOf(a.windows[0]).visible === false && a.overviewMode === true); }
  { const big = [{ seq: 60, x: -8, y: -8, w: 2576, h: 1456 }, { seq: 61, x: 400, y: 300, w: 900, h: 700 }]; // maximized, overhanging
    const a = expoThumb(big, 9); logs.length = 0; E.overviewModeOn.call(a); const fr = shownOf(a).map(frameOnScreen);
    ok('a window bigger than its monitor is shrunk to fit like any other', !logs.some(l => l[0] === 'error') &&
      fr.every(g => { const m = d('expo-margin') - 0.5; return g.x >= m + OVERHANG && g.y >= m + OVERHANG && g.x + g.w <= 2560 - m && g.y + g.h <= 1440 - m; })); }
  { const r = SL.random(77), many = Array.from({ length: 30 }, (_, i) => { const w = 300 + r() * 1200, h = 200 + r() * 800; return { seq: 100 + i, x: r() * (2560 - w), y: r() * (1440 - h), w, h }; });
    const a = expoThumb(many, 10); logs.length = 0; const t0 = Date.now(); E.overviewModeOn.call(a); const ms = Date.now() - t0;
    const fr = shownOf(a).map(frameOnScreen); let bad = 0;
    for (const g of fr) for (const h of fr) if (g !== h && Math.max(h.x - (g.x + g.w), g.x - (h.x + h.w), h.y - (g.y + g.h), g.y - (h.y + h.h)) < d('expo-spacing') - 0.01) bad++;
    ok('a crowded workspace (30 windows): no overlaps, gaps kept, thumbnails never larger than real size', !bad && fr.every(g => g.scale <= 1 + 1e-9), ms + ' ms'); }
  settingsNow().setValue('debug-log', false);

  // ---------------------------------------------------------------- the Enable switches
  section('Cinnamon integration: Enable switches');
  { const st = settingsNow();
    // Show all windows, as Cinnamon would compute it: slots and the title width it sets
    const scaleState = (fn) => { const m = monitor(frames); const slotsOut = fn.call(m, n); return JSON.stringify({ slots: slotsOut, slotWidth: m._slotWidth }); };
    // keyboard: every arrow key from every starting thumbnail, after a layout
    const navState = (slotsFn, selectFn) => {
      const out = [];
      for (let start = 0; start < n; start++) for (const key of ['KEY_Left', 'KEY_Right', 'KEY_Up', 'KEY_Down', 'KEY_Home', 'KEY_End']) {
        const m = monitor(frames); slotsFn.call(m, n); m._kbWindowIndex = start; m._selected = undefined;
        const handled = selectFn.call(m, Clutter[key]);
        out.push([start, key, handled, m._selected ? m._windows.indexOf(m._selected) : -1]);
      }
      return JSON.stringify(out);
    };
    const expoState = (fn) => { const th = expoThumb(EXPO_SPECS, 13); fn.call(th);
      return JSON.stringify(th.windows.map(w => [frameOnScreen(w), badgeOf(w), actorOf(w).visible, actorOf(w).opacity])); };
    const originalScale = scaleState(original.slots), originalNav = navState(original.slots, original.select), originalExpo = expoState(expoOriginal);
    ok('switched on, Show all windows differs from Cinnamon\'s own (sanity check)', scaleState(P._computeAllWindowSlots) !== originalScale);

    st.setValue('scale-enabled', false);
    ok('Show all windows switched off: exactly Cinnamon\'s slots and title width', scaleState(P._computeAllWindowSlots) === originalScale);
    ok('Show all windows switched off: exactly Cinnamon\'s keyboard navigation', navState(P._computeAllWindowSlots, P.selectAnotherWindow) === originalNav, 'every arrow, Home and End from every thumbnail');
    ok('Show all windows switched off: Show all workspaces still arranged by the extension', expoState(E.overviewModeOn) !== originalExpo);

    // switched off while the view is open: the same window clones were laid out by the extension before
    { const stale = [];
      for (let start = 0; start < n; start++) for (const key of ['KEY_Left', 'KEY_Right', 'KEY_Up', 'KEY_Down']) {
        st.setValue('scale-enabled', true);
        const m = monitor(frames); P._computeAllWindowSlots.call(m, n);   // laid out by the extension
        st.setValue('scale-enabled', false);
        P._computeAllWindowSlots.call(m, n);                              // re-laid out by Cinnamon
        m._kbWindowIndex = start; m._selected = undefined;
        const handled = P.selectAnotherWindow.call(m, Clutter[key]);
        stale.push([start, key, handled, m._selected ? m._windows.indexOf(m._selected) : -1]);
      }
      const reference = JSON.parse(originalNav).filter(r => ['KEY_Left', 'KEY_Right', 'KEY_Up', 'KEY_Down'].indexOf(r[1]) >= 0);
      ok('switched off while the view is open: navigation immediately follows Cinnamon\'s grid', JSON.stringify(stale) === JSON.stringify(reference)); }

    st.setValue('expo-enabled', false);
    ok('both switched off: Show all windows exactly as Cinnamon', scaleState(P._computeAllWindowSlots) === originalScale &&
      navState(P._computeAllWindowSlots, P.selectAnotherWindow) === originalNav);
    ok('both switched off: Show all workspaces exactly as Cinnamon (positions, badges, visibility)', expoState(E.overviewModeOn) === originalExpo);

    st.setValue('scale-enabled', true);
    ok('only Show all workspaces switched off: Show all windows arranged by the extension again', scaleState(P._computeAllWindowSlots) !== originalScale &&
      expoState(E.overviewModeOn) === originalExpo);
    st.setValue('expo-enabled', true); }

  section('Cinnamon integration: disabling');
  ext.disable();
  ok('disable() restores Cinnamon\'s original methods exactly', P._computeAllWindowSlots === original.slots && P.selectAnotherWindow === original.select &&
    E.overviewModeOn === expoOriginal);
  ok('disable() releases the settings object', instances.every(s => s.finalized));
}

module.exports = { run };
if (require.main === module) run().then(() => {
  const t = require('./lib/check').totals();
  console.log('\n' + t.passed + ' passed, ' + t.failed + ' failed');
  process.exit(t.failed ? 1 : 0);
}, e => { console.error(e); process.exit(1); });
