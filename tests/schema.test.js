// Tests settings-schema.json and metadata.json. Run alone with: node tests/schema.test.js
// Checks against Cinnamon's real code: the settings dialog's widget types (xlet-settings.py) and
// the required fields per setting type (js/ui/settings.js).
const fs = require('fs'), path = require('path');
const { section, ok } = require('./lib/check');
const { cinnamonSources } = require('./lib/cinnamon');
const EXT = path.join(__dirname, '..', 'extension', 'window-spread@soren-kragh');

async function run() {
  const C = await cinnamonSources();
  const SL = require(path.join(EXT, 'spreadLayout.js'));
  const fileText = fs.readFileSync(path.join(EXT, 'settings-schema.json'), 'utf8');
  const schema = JSON.parse(fileText);
  const extSrc = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');

  section('Settings: consistency with the engine and the extension');
  ok('settings-schema.json is exactly what tools/build-schema.js generates from the engine\'s DEFAULTS',
    require(path.join(__dirname, '..', 'tools', 'build-schema.js')).text === fileText,
    'if not: run node tools/build-schema.js');
  const map = []; const re = /\["([a-z-]+)", "(common|scoring|optimizer|push|rows|grid)", "(\w+)"(?:, (\d+))?\]/g; let m;
  while ((m = re.exec(extSrc))) map.push({ key: m[1], group: m[2], engineKey: m[3], unit: m[4] ? +m[4] : 0 });
  ok('every setting the extension maps has the engine\'s default (times its unit)', map.length > 0 && map.every(e => schema[e.key] && (e.unit ? schema[e.key].default * e.unit : schema[e.key].default) === SL.DEFAULTS[e.group][e.engineKey]), map.length + ' settings');
  const read = []; const re2 = /(?:getValue|readConfig)\("([a-z-]+)"/g; // direct reads, and the algorithm keys passed to readConfig()
  while ((m = re2.exec(extSrc))) read.push(m[1]);
  const settingKeys = Object.keys(schema).filter(k => 'default' in schema[k]);
  const used = map.map(e => e.key).concat(read);
  ok('the extension reads exactly the settings the file defines',
    settingKeys.every(k => used.indexOf(k) >= 0) && used.every(k => settingKeys.indexOf(k) >= 0));
  // the log names algorithms as the settings window does
  const names = new Function('return ' + /const ALGORITHM_NAMES = (\{[^}]*\})/.exec(extSrc)[1])();
  const shown = {};
  for (const [label, id] of Object.entries(schema.algorithm.options)) shown[id] = label;
  ok('the log names the algorithms as the settings window does, and the engine has exactly those',
    JSON.stringify(names) === JSON.stringify(shown) &&
    JSON.stringify(Object.keys(names).sort()) === JSON.stringify(SL.ALGORITHMS.slice().sort()));

  section('Settings: what Cinnamon\'s settings dialog and settings code accept');
  const xs = fs.readFileSync(C.path('files/usr/share/cinnamon/cinnamon-settings/xlet-settings.py'), 'utf8');
  const widgets = (xs.match(/^\s+"([a-z]+)"\s*:\s*"JSONSettings/gm) || []).map(l => /"([a-z]+)"/.exec(l)[1]).concat(['button', 'label']);
  const setjs = fs.readFileSync(C.path('js/ui/settings.js'), 'utf8');
  const typesBlock = setjs.slice(setjs.indexOf('var SETTINGS_TYPES = {'), setjs.indexOf('var NON_SETTING_TYPES'));
  const SETTINGS_TYPES = new Function('return ' + typesBlock.replace('var SETTINGS_TYPES = ', '').replace(/;\s*$/, ''))();
  const nonBlock = setjs.slice(setjs.indexOf('var NON_SETTING_TYPES = {'), setjs.indexOf('function settings_not_initialized_error'));
  const NON_SETTING_TYPES = new Function('return ' + nonBlock.replace('var NON_SETTING_TYPES = ', '').replace(/;\s*$/, ''))();
  const entries = Object.keys(schema).filter(k => k !== 'layout');
  ok('every entry uses a widget type the dialog supports', entries.every(k => widgets.indexOf(schema[k].type) >= 0));
  ok('every entry has the fields Cinnamon requires for its type', entries.every(k => {
    const def = SETTINGS_TYPES[schema[k].type] || NON_SETTING_TYPES[schema[k].type];
    return !def || def['required-fields'].every(f => f in schema[k]);
  }));
  const bad = entries.filter(k => {
    const v = schema[k];
    if (v.type === 'scale' || v.type === 'spinbutton') {
      const steps = (v.default - v.min) / v.step;
      return v.default < v.min - 1e-9 || v.default > v.max + 1e-9 || Math.abs(steps - Math.round(steps)) > 1e-6;
    }
    if (v.type === 'combobox') return Object.keys(v.options).map(l => v.options[l]).indexOf(v.default) < 0;
    if (v.type === 'switch') return typeof v.default !== 'boolean';
    return false;
  });
  ok('defaults are valid: within range and on the step grid, among the options, booleans for switches', !bad.length, bad.join(', '));
  const blankSpin = entries.filter(k => schema[k].type === 'spinbutton' && schema[k].default === 0);
  ok('no spin button defaults to 0 (Cinnamon\'s dialog would show it blank)', !blankSpin.length, blankSpin.join(', '));
  const comboTypes = entries.filter(k => schema[k].type === 'combobox').filter(k => {
    const vals = Object.keys(schema[k].options).map(l => schema[k].options[l]);
    return vals.some(v => typeof v !== typeof vals[0]);
  });
  ok('drop-down options all have the same value type (the dialog requires this)', !comboTypes.length, comboTypes.join(', '));
  const OPS = ['<=', '>=', '<', '>', '!=', '='];
  ok('conditional settings refer to existing settings', entries.every(k => {
    const dep = schema[k].dependency; if (!dep) return true;
    let key = dep.replace(/^!/, '');
    for (const op of OPS) if (dep.indexOf(op) >= 0) { key = dep.split(op)[0]; break; }
    return key in schema;
  }));

  section('Settings: pages');
  const L = schema.layout, first = Object.keys(schema)[0];
  ok('the layout is the first entry (the dialog requires this)', first === 'layout' && L.type === 'layout');
  const sectionKeys = [];
  let pagesOk = true;
  for (const p of L.pages) {
    if (!L[p] || L[p].type !== 'page' || !L[p].title) { pagesOk = false; continue; }
    for (const s of L[p].sections) { if (!L[s] || L[s].type !== 'section' || !L[s].title) pagesOk = false; else sectionKeys.push.apply(sectionKeys, L[s].keys); }
  }
  ok('pages and sections are well formed', pagesOk, L.pages.map(p => L[p].title).join(', '));
  ok('every setting and button appears on exactly one page',
    entries.every(k => sectionKeys.filter(x => x === k).length === 1) && sectionKeys.every(k => entries.indexOf(k) >= 0));
  const sectionDepsOk = L.pages.every(p => L[p].sections.every(sec => {
    const dep = L[sec].dependency; if (!dep) return true;
    let key = dep.replace(/^!/, ''); for (const op of OPS) if (dep.indexOf(op) >= 0) { key = dep.split(op)[0]; break; }
    return key in schema;
  }));
  ok('section conditions refer to existing settings', sectionDepsOk);
  // A view's Enable switch must hide every other setting on its tab (via the section condition).
  for (const sw of ['scale-enabled', 'expo-enabled']) {
    const page = L.pages.filter(p => L[p].sections.some(sec => L[sec].keys.indexOf(sw) >= 0))[0];
    const others = L[page].sections.filter(sec => L[sec].keys.indexOf(sw) < 0);
    ok('"' + L[page].title + '": switching Enable off hides all its other settings',
      others.length > 0 && others.every(sec => L[sec].dependency === sw) &&
      L[page].sections.filter(sec => L[sec].keys.indexOf(sw) >= 0).every(sec => L[sec].keys.length === 1));
  }
  const most = Math.max.apply(null, L.pages.map(p => L[p].sections.reduce((a, s) => a + L[s].keys.length, 0)));
  // 9 = the Show all workspaces tab with every conditional setting showing (another algorithm
  // than the grid, and gap filling on).
  ok('pages are short (avoids scrolling, where the mouse wheel would change sliders)', most <= 9, 'at most ' + most + ' settings per page');

  section('Extension metadata');
  const meta = JSON.parse(fs.readFileSync(path.join(EXT, 'metadata.json'), 'utf8'));
  const ex = fs.readFileSync(C.path('js/ui/extension.js'), 'utf8');
  // The extension type's required and nice-to-have properties, as listed in Cinnamon's extension.js
  const extType = ex.slice(ex.indexOf('EXTENSION: _createExtensionType'));
  const listAfter = label => new Function('return ' + new RegExp(label + ':\\s*(\\[[^\\]]*\\])').exec(extType)[1])();
  const required = listAfter('requiredProperties'), niceToHave = listAfter('niceToHaveProperties');
  ok('has the properties this Cinnamon version requires', required.every(p => meta[p]), required.join(', '));
  ok('has the nice-to-have properties (otherwise Cinnamon logs a warning)', niceToHave.every(p => meta[p]), niceToHave.join(', '));
  ok('uuid matches the folder name (otherwise Cinnamon refuses to load it)', meta.uuid === path.basename(EXT));
  // Cinnamon's own version check: cinnamon-version lists minimum versions
  const vsrc = /function versionCheck\(required, current\) \{[\s\S]*?\n\}/.exec(ex)[0];
  const versionCheck = new Function('var requiredMajor, requiredMinor;\n' + vsrc + '\nreturn versionCheck;')();
  const running = /^\d+\.\d+/.test(C.version) ? C.version : '6.0.5';
  ok('Cinnamon ' + running + ' accepts the declared cinnamon-version (a minimum version)', versionCheck(meta['cinnamon-version'], running),
    'cinnamon-version ' + JSON.stringify(meta['cinnamon-version']));
}

module.exports = { run };
if (require.main === module) run().then(() => {
  const t = require('./lib/check').totals();
  console.log('\n' + t.passed + ' passed, ' + t.failed + ' failed');
  process.exit(t.failed ? 1 : 0);
}, e => { console.error(e); process.exit(1); });
