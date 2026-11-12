// Runs all tests:  node tests/run-all.js
// Needs Node.js (Mint: sudo apt install nodejs). The Cinnamon checks read the installed
// Cinnamon files, or download the matching version from GitHub. The lab checks need jsdom
// (see tests/lab.test.js) and are skipped without it.
const { totals } = require('./lib/check');
const files = ['engine.test.js', 'schema.test.js', 'extension.test.js', 'spices.test.js', 'lab.test.js'];
(async () => {
  for (const f of files) {
    try { await require('./' + f).run(); }
    catch (e) { require('./lib/check').ok(f + ' ran to completion', false, e && e.message); }
  }
  const t = totals();
  console.log('\n' + '='.repeat(60) + '\n' + t.passed + ' passed, ' + t.failed + ' failed' + (t.skipped ? ', ' + t.skipped + ' skipped' : ''));
  process.exit(t.failed ? 1 : 0);
})();
