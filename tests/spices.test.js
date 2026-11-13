// Tests tools/build-spices.js, including Cinnamon Spices' own validator.
// Run alone with: node tests/spices.test.js
// The validator (validate-spice, a Python script) is downloaded from the official
// linuxmint/cinnamon-spices-extensions repository and cached in tests/.cinnamon-src/spices/.
// It needs python3 with PIL (Mint: sudo apt install python3-pil); without it, that check is skipped.
const fs = require('fs'), path = require('path'), os = require('os'), https = require('https');
const { spawnSync } = require('child_process');
const { section, ok, skip } = require('./lib/check');
const ROOT = path.join(__dirname, '..');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, Buffer.concat(chunks)); resolve(); });
    }).on('error', reject);
  });
}
function listFiles(dir, base) {
  base = base || dir; let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listFiles(p, base)); else out.push(path.relative(base, p));
  }
  return out.sort();
}

async function run() {
  section('Cinnamon Spices package');
  const extRoot = path.join(ROOT, 'extension'), UUID = fs.readdirSync(extRoot)[0], extDir = path.join(extRoot, UUID);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spices-'));
  try {
    const build = args => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-spices.js')].concat(args), { encoding: 'utf8' });

    const noShot = build(['--screenshot', path.join(tmp, 'missing.png'), '--out', tmp]);
    ok('without a screenshot, the build refuses with an explanation', noShot.status !== 0 && /screenshot/.test(noShot.stderr));

    // a placeholder screenshot (any PNG) stands in for the real one
    const res = build(['--screenshot', path.join(extDir, 'icon.png'), '--out', tmp]);
    ok('the build succeeds and passes its own checks', res.status === 0, (res.stderr || '').trim());
    const target = path.join(tmp, UUID);
    ok('top level holds exactly info.json, README.md, screenshot.png and files/',
      fs.readdirSync(target).sort().join(',') === 'README.md,files,info.json,screenshot.png');
    ok('files/ holds only the ' + UUID + ' folder', fs.readdirSync(path.join(target, 'files')).join(',') === UUID);
    const a = listFiles(extDir), b = listFiles(path.join(target, 'files', UUID));
    ok('files/' + UUID + '/ is exactly the extension folder (same files, same contents)',
      a.join() === b.join() && a.every(f => fs.readFileSync(path.join(extDir, f)).equals(fs.readFileSync(path.join(target, 'files', UUID, f)))), a.join(', '));
    ok('info.json names the author', JSON.parse(fs.readFileSync(path.join(target, 'info.json'), 'utf8')).author === 'soren-kragh');

    // Spices' own validator
    const pil = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' });
    if (pil.status !== 0) { skip('Spices\' validate-spice accepts the package', 'needs python3 with PIL (Mint: sudo apt install python3-pil)'); return; }
    const validator = path.join(__dirname, '.cinnamon-src', 'spices', 'validate-spice');
    try { if (!fs.existsSync(validator)) await download('https://raw.githubusercontent.com/linuxmint/cinnamon-spices-extensions/master/validate-spice', validator); }
    catch (e) { skip('Spices\' validate-spice accepts the package', 'could not download it: ' + e.message); return; }
    const v = spawnSync('python3', [validator, UUID], { cwd: tmp, encoding: 'utf8' });
    ok('Spices\' validate-spice accepts the package', v.status === 0 && /No errors found/.test(v.stdout), (v.stdout + v.stderr).trim().split('\n').pop());
  } finally { // fs.rmSync needs Node 14.14; Mint 21.3 has Node 12
    (fs.rmSync || fs.rmdirSync).call(fs, tmp, { recursive: true, force: true });
  }
}

module.exports = { run };
if (require.main === module) run().then(() => {
  const t = require('./lib/check').totals();
  console.log('\n' + t.passed + ' passed, ' + t.failed + ' failed' + (t.skipped ? ', ' + t.skipped + ' skipped' : ''));
  process.exit(t.failed ? 1 : 0);
}, e => { console.error(e); process.exit(1); });
