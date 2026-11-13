// Tests the lab page in a simulated browser. Run alone with: node tests/lab.test.js
// Needs the jsdom package, which is not part of Node. Install it once, from the tests folder:
//   npm install jsdom          (Node 18 or later)
//   npm install jsdom@16       (older Node, e.g. Mint 21.3's packaged Node 12)
// Without jsdom, these checks are skipped.
const fs = require('fs'), path = require('path'), os = require('os');
const { section, ok, skip } = require('./lib/check');
const LAB = path.join(__dirname, '..', 'lab', 'window-spread-lab.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadJsdom() {
  for (const where of [__dirname, path.join(__dirname, '..')]) {
    try { return require(require.resolve('jsdom', { paths: [where] })); } catch (e) { /* try next */ }
  }
  return null;
}

async function open(file, jsdom, quiet) {
  const opts = { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) { w.ResizeObserver = class { observe() {} }; w.matchMedia = () => ({ matches: false }); } };
  if (quiet) opts.virtualConsole = new jsdom.VirtualConsole();
  const dom = await jsdom.JSDOM.fromFile(file, opts);
  for (let i = 0; i < 50 && !dom.window.document.getElementById('algo') && !dom.window.document.querySelector('h1'); i++) await sleep(100);
  await sleep(800); // external engine script and start-up
  return dom;
}

async function run() {
  section('Lab page');
  const jsdom = loadJsdom();
  if (!jsdom) { skip('lab page checks', 'jsdom not installed; see the comment at the top of tests/lab.test.js'); return; }

  const dom = await open(LAB, jsdom), w = dom.window, d = w.document, errors = [];
  w.addEventListener('error', e => errors.push(e.message));
  const SL = w.SpreadLayout;
  ok('the engine loads from the extension folder (no copy in the page)', typeof SL === 'object' && fs.readFileSync(LAB, 'utf8').indexOf('function createSpreadLayout') < 0);
  ok('opens with the optimizer selected', d.getElementById('algo').value === 'optimizer');
  const stat = name => { const it = [].slice.call(d.querySelectorAll('#statsbar .it')).filter(e => e.textContent.indexOf(name) === 0)[0]; return it ? it.querySelector('b').textContent : null; };
  const layout = () => JSON.stringify(Array.from(w.eval('targets').values()).sort((a, b) => a.id - b.id));

  d.getElementById('explode').click(); await sleep(150);
  ok('opening the spread shows a score', stat('Score') !== null, 'score ' + stat('Score'));
  const first = layout();
  d.getElementById('shuffleZ').click(); await sleep(150);
  ok('"Test: shuffle stacking" leaves the layout unchanged and reuses the cache', layout() === first && /hit/.test(stat('Cache') || ''));

  d.getElementById('explode').click(); await sleep(50);
  const el = d.querySelectorAll('.win')[2];
  el.querySelector('.min').click();
  ok('a minimized window is hidden on the desktop', el.classList.contains('minimized'));
  d.getElementById('explode').click(); await sleep(150);
  ok('and shown normally in the spread, with an unchanged layout', !el.classList.contains('minimized') && layout() === first);
  el.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, button: 0 })); await sleep(50);
  ok('clicking its thumbnail closes the spread and restores it', !w.eval('exploded') && !el.classList.contains('minimized'));

  d.getElementById('compareAll').click(); d.getElementById('explode').click(); await sleep(600);
  const panels = d.querySelectorAll('.cmp');
  ok('comparison view shows four panels, one marked best', panels.length === 4 && d.querySelectorAll('.cmp .score:not(.plain)').length >= 1);
  d.getElementById('explode').click(); d.getElementById('compareAll').click();

  [].slice.call(d.querySelectorAll('aside input[type=range]')).forEach(r => { r.value = r.min; r.dispatchEvent(new w.Event('input')); });
  d.getElementById('reset').click();
  ok('"Reset settings" restores the engine\'s defaults', w.eval('P.margin') === SL.DEFAULTS.common.margin && w.eval('P.wSize') === SL.DEFAULTS.scoring.wSize &&
    w.eval('algoParams.optimizer.steps') === SL.DEFAULTS.optimizer.steps);

  // the tuner's worker code: the engine rebuilt from its factory, plus the evaluator
  let workerOk = false;
  try {
    const { Worker } = require('worker_threads');
    const src = w.eval('workerSource()');
    const shim = "const { parentPort } = require('worker_threads'); globalThis.postMessage = m => parentPort.postMessage(m);\n" + src +
      "\nparentPort.on('message', m => onmessage({ data: m }));";
    const msg = JSON.parse(JSON.stringify({ id: 1, settings: w.eval('settingsFor("optimizer")'), desktops: w.eval('tuneDesktops()').slice(0, 2), seeds: [1], bestRuns: null, screen: w.eval('SCREEN') }));
    msg.settings.steps = 200;
    const res = await new Promise((resolve, reject) => {
      const wk = new Worker(shim, { eval: true });
      wk.on('message', m => { wk.terminate(); resolve(m); }); wk.on('error', reject);
      wk.postMessage(msg);
    });
    workerOk = res && res.runs && res.runs.length === 2 && res.mean > 0;
  } catch (e) { errors.push('worker: ' + e.message); }
  ok('the tuner\'s worker code runs the engine in a separate thread', workerOk);
  ok('no errors on the page', errors.length === 0, errors.join('; '));

  // opened outside the folder: the engine can't be found, and the page says so
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-'));
  fs.copyFileSync(LAB, path.join(tmp, 'lab.html'));
  const lost = await open(path.join(tmp, 'lab.html'), jsdom, true);
  const h1 = lost.window.document.querySelector('h1');
  ok('opened outside the folder, the page explains that the engine was not found', !!h1 && /engine not found/i.test(h1.textContent));
  dom.window.close(); lost.window.close();
  (fs.rmSync || fs.rmdirSync).call(fs, tmp, { recursive: true, force: true }); // rmSync: Node 14.14+
}

module.exports = { run };
if (require.main === module) run().then(() => {
  const t = require('./lib/check').totals();
  console.log('\n' + t.passed + ' passed, ' + t.failed + ' failed, ' + t.skipped + ' skipped');
  process.exit(t.failed ? 1 : 0);
}, e => { console.error(e); process.exit(1); });
