// Runs all tests against several Cinnamon versions (downloaded from GitHub) and prints a table.
//   node tests/run-versions.js                      the versions listed below
//   node tests/run-versions.js 6.8.0 6.8.1          specific versions
// Use this when a new Cinnamon release appears: it shows whether the extension still fits.
const { spawnSync } = require('child_process'), path = require('path');
const DEFAULT_VERSIONS = ['6.0.5', '6.2.10', '6.4.14', '6.6.9', '6.8.0']; // latest of each series as of November 2026
const versions = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_VERSIONS;
const rows = [];
for (const v of versions) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'run-all.js')],
    { env: Object.assign({}, process.env, { CINNAMON_SOURCE: 'download', CINNAMON_VERSION: v }), encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const summary = /(\d+) passed, (\d+) failed(?:, (\d+) skipped)?/.exec(out.split('\n').filter(l => /passed, \d+ failed/.test(l)).pop() || '');
  const failures = out.split('\n').filter(l => /^\s+FAIL /.test(l)).map(l => l.trim());
  rows.push({ v, ok: r.status === 0, summary: summary ? summary[0] : 'did not complete', failures, loader: (/extension loader: (.*)/.exec(out) || [])[1] || '' });
}
console.log('\nCinnamon   result');
for (const row of rows) {
  console.log(row.v.padEnd(10) + ' ' + (row.ok ? 'OK    ' : 'FAILED') + ' ' + row.summary + (row.loader ? '   [' + row.loader + ']' : ''));
  for (const f of row.failures) console.log('             ' + f);
}
process.exit(rows.every(r => r.ok) ? 0 : 1);
