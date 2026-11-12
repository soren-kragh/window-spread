// Finds the Cinnamon source files the tests run against.
//   Default: the installed files under /usr/share/cinnamon, if present.
//   Otherwise (or with CINNAMON_SOURCE=download): downloads them from the official
//   linuxmint/cinnamon repository on GitHub, for CINNAMON_VERSION (default: the installed
//   version from `cinnamon --version`, else 6.0.5), into tests/.cinnamon-src/<version>/.
const fs = require('fs'), path = require('path'), https = require('https'), crypto = require('crypto');
const { execSync } = require('child_process');

// repository path -> installed path
const FILES = {
  'js/ui/workspace.js': '/usr/share/cinnamon/js/ui/workspace.js',
  'js/ui/extension.js': '/usr/share/cinnamon/js/ui/extension.js',
  'js/ui/expoThumbnail.js': '/usr/share/cinnamon/js/ui/expoThumbnail.js',
  'js/ui/settings.js': '/usr/share/cinnamon/js/ui/settings.js',
  'js/ui/main.js': '/usr/share/cinnamon/js/ui/main.js',
  'js/misc/gridNavigator.js': '/usr/share/cinnamon/js/misc/gridNavigator.js',
  'js/misc/fileUtils.js': '/usr/share/cinnamon/js/misc/fileUtils.js',
  'files/usr/share/cinnamon/cinnamon-settings/xlet-settings.py': '/usr/share/cinnamon/cinnamon-settings/xlet-settings.py',
};
// SHA-256 of these files in Cinnamon 6.0.5, the version the extension was written and checked against.
const KNOWN_605 = {
  'js/ui/workspace.js': '7fdd71235ca4d379b1cdf07535bc5e6959a89839d1c33f4107b57e590da97ded',
  'js/ui/expoThumbnail.js': '3080709658d2f710c038890d494aa937b7c3abdcb2ce8c53ad8f138a9c77b66e',
  'js/ui/extension.js': 'a7b5e888923012e2d43ac06a7167f5e5185a2072668c62f16334f83dfcf5120f',
  'js/ui/settings.js': 'a8ff79a45a431a6042089d168dbdde83f425cbe2d77b227ccc6fe37b82a2a518',
  'js/ui/main.js': '4d1481eaeb1b3f8a0c07a587a483d6729a10512ad39a645ec9fb3478783ec2cd',
  'js/misc/gridNavigator.js': '54e31c75627546a9ace3168d69e77882eab7bb8c0313a42f50b8289d3d51a78e',
  'js/misc/fileUtils.js': '7a3dfa71ffc0af5f42a972250b049dd27ab4ef886256699d3e4a0ef79ffc74f1',
  'files/usr/share/cinnamon/cinnamon-settings/xlet-settings.py': '1c37081b72e1eeddd34620c0d71216c5116503cbc3a2f02cc76e4d48295d784c',
};

function installedVersion() {
  try { const m = /(\d+\.\d+\.\d+)/.exec(execSync('cinnamon --version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()); return m ? m[1] : null; }
  catch (e) { return null; }
}
function download(url, dest) {
  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); return; }
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, Buffer.concat(chunks)); resolve(); });
    }).on('error', reject);
  });
}
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

let cached = null;
// Returns { version, origin, path(repoPath) -> local file, matches605: bool }
async function cinnamonSources() {
  if (cached) return cached;
  const mode = process.env.CINNAMON_SOURCE || 'auto';
  const haveLocal = Object.values(FILES).every(p => fs.existsSync(p));
  let resolvePath, version, origin;
  if (mode !== 'download' && haveLocal) {
    version = installedVersion() || 'installed';
    origin = 'installed files in /usr/share/cinnamon';
    resolvePath = p => FILES[p];
  } else {
    version = process.env.CINNAMON_VERSION || installedVersion() || '6.0.5';
    const dir = path.join(__dirname, '..', '.cinnamon-src', version);
    for (const p of Object.keys(FILES)) {
      const dest = path.join(dir, p);
      if (!fs.existsSync(dest)) await download('https://raw.githubusercontent.com/linuxmint/cinnamon/' + version + '/' + p, dest);
    }
    origin = 'Cinnamon ' + version + ' source from GitHub (cached in tests/.cinnamon-src)';
    resolvePath = p => path.join(dir, p);
  }
  const matches605 = Object.keys(FILES).every(p => sha256(resolvePath(p)) === KNOWN_605[p]);
  cached = { version, origin, path: resolvePath, matches605 };
  return cached;
}
module.exports = { cinnamonSources };
