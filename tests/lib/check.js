// Minimal test reporting, shared by all test files. Works with Node 12 and later.
let passed = 0, failed = 0, skipped = 0;
function section(title) { console.log('\n== ' + title + ' =='); }
function ok(label, condition, detail) {
  if (condition) passed++; else failed++;
  console.log((condition ? '  PASS ' : '  FAIL ') + label + (detail ? '   (' + detail + ')' : ''));
}
function skip(label, reason) { skipped++; console.log('  SKIP ' + label + '   (' + reason + ')'); }
function note(text) { console.log('       ' + text); }
function totals() { return { passed, failed, skipped }; }
module.exports = { section, ok, skip, note, totals };
