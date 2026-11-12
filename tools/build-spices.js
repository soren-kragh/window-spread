// Builds the folder for publishing this extension on Cinnamon Spices:
//
//   node tools/build-spices.js [--screenshot FILE] [--out DIR]
//
// Creates <out>/<UUID>/ (default out: dist/spices) in the structure Spices requires:
//   <UUID>/info.json        from tools/spices/info.json (the author's GitHub username)
//   <UUID>/README.md        from tools/spices/README.md (written for Spices users)
//   <UUID>/screenshot.png   from docs/screenshot.png (or --screenshot)
//   <UUID>/files/<UUID>/    the extension folder, exactly as in extension/
// and checks it against Spices' rules (the same checks as Spices' validate-spice script).
// To publish: copy <out>/<UUID> into your fork of linuxmint/cinnamon-spices-extensions,
// run ./validate-spice <UUID> there, and open a pull request.
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");

function fail(msg) { console.error("build-spices: " + msg); process.exit(1); }
function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
// Width and height of a PNG file, from its header (no image library needed).
function pngSize(file) {
  const b = fs.readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((v, i) => b[i] === v)) return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

// --- the extension and its identifier
const extRoot = path.join(ROOT, "extension");
const dirs = fs.readdirSync(extRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
if (dirs.length !== 1) fail("extension/ should contain exactly one extension folder");
const UUID = dirs[0], extDir = path.join(extRoot, UUID);
const metadata = JSON.parse(fs.readFileSync(path.join(extDir, "metadata.json"), "utf8"));
if (metadata.uuid !== UUID) fail(`metadata.json uuid "${metadata.uuid}" differs from the folder name "${UUID}"`);

// --- inputs
const screenshot = arg("--screenshot") || path.join(ROOT, "docs", "screenshot.png");
if (!fs.existsSync(screenshot)) fail(`no screenshot: add a PNG of Show all windows as docs/screenshot.png (or pass --screenshot FILE)`);
if (!pngSize(screenshot)) fail(`${screenshot} is not a PNG file`);
const out = path.resolve(arg("--out") || path.join(ROOT, "dist", "spices"));
const target = path.join(out, UUID);

// --- build
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(path.join(__dirname, "spices", "info.json"), path.join(target, "info.json"));
fs.copyFileSync(path.join(__dirname, "spices", "README.md"), path.join(target, "README.md"));
fs.copyFileSync(screenshot, path.join(target, "screenshot.png"));
copyDir(extDir, path.join(target, "files", UUID));

// --- check against Spices' rules (as in their validate-spice script)
const problems = [];
for (const f of ["info.json", "screenshot.png", `files/${UUID}/metadata.json`, `files/${UUID}/icon.png`, `files/${UUID}/extension.js`])
  if (!fs.existsSync(path.join(target, f))) problems.push("missing file " + f);
if (fs.existsSync(path.join(target, "icon.png"))) problems.push("icon.png must not be at the top level");
const inFiles = fs.readdirSync(path.join(target, "files"));
if (inFiles.length !== 1 || inFiles[0] !== UUID) problems.push(`files/ must contain only the ${UUID} folder`);
const info = JSON.parse(fs.readFileSync(path.join(target, "info.json"), "utf8"));
if (!info.author || /\s/.test(info.author)) problems.push("info.json needs an author without whitespace");
for (const f of ["uuid", "name", "description"]) if (!metadata[f]) problems.push(`metadata.json lacks "${f}"`);
for (const f of ["icon", "dangerous", "last-edited"]) if (f in metadata) problems.push(`metadata.json must not have "${f}"`);
for (const [k, v] of Object.entries(metadata))
  if (Buffer.byteLength(String(v)) !== String(v).length) problems.push(`metadata.json "${k}" must be plain ASCII`);
const icon = pngSize(path.join(target, "files", UUID, "icon.png"));
if (!icon || icon[0] !== icon[1]) problems.push("icon.png must be a square PNG");
for (const f of fs.readdirSync(path.join(target, "files", UUID)))
  if (/\.(po|pot|mo)$/.test(f)) problems.push("translation files belong in files/" + UUID + "/po (and .mo files not at all)");
if (problems.length) fail("the result breaks Spices' rules:\n  " + problems.join("\n  "));

console.log(`Built ${path.relative(process.cwd(), target) || target}`);
console.log(`Next: copy it into your fork of linuxmint/cinnamon-spices-extensions, run ./validate-spice ${UUID} there, and open a pull request.`);
