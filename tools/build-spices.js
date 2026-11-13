// Builds the folder for publishing this extension on Cinnamon Spices:
//
//   node tools/build-spices.js [--screenshot FILE] [--out DIR] [--allow-uncommitted]
//
// Creates <out>/<UUID>/ (default out: dist/spices) in the structure Spices requires:
//   <UUID>/info.json        from tools/spices/info.json (the author's GitHub username)
//   <UUID>/README.md        from tools/spices/README.md (written for Spices users)
//   <UUID>/screenshot.png   from docs/screenshot.png (or --screenshot)
//   <UUID>/files/<UUID>/    the extension folder (in a git clone: the files git tracks)
// and checks it against Spices' rules (the same checks as Spices' validate-spice script).
// In a git clone it refuses to build while the extension folder has changes that aren't
// committed, or files git doesn't track (also ignored ones), unless --allow-uncommitted (for
// tests); even then only tracked files are copied. Outside a clone (e.g. an unpacked ZIP),
// every file in the extension folder is copied.
// To publish: copy <out>/<UUID> into your fork of linuxmint/cinnamon-spices-extensions,
// run ./validate-spice <UUID> there, and open a pull request.
"use strict";
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");

function fail(msg) { console.error("build-spices: " + msg); process.exit(1); }
// Remove a folder and its contents (fs.rmSync needs Node 14.14; Mint 21.3 has Node 12).
function removeDir(p) { if (fs.existsSync(p)) (fs.rmSync || fs.rmdirSync).call(fs, p, { recursive: true, force: true }); }
function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
function git(args) { return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }); }
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

// In a clone of the repository, only what is committed may ship: no uncommitted edits, no
// stray files (editor backups, experiments, ignored files). Elsewhere (e.g. an unpacked
// ZIP of a commit) git can't tell, so the whole folder is used.
const top = git(["rev-parse", "--show-toplevel"]);
const inClone = !top.error && top.status === 0 && fs.realpathSync(top.stdout.trim()) === fs.realpathSync(ROOT);
let files; // paths relative to ROOT
if (inClone) {
  const tracked = git(["ls-files", "-z", "--", extDir]);
  if (tracked.status !== 0) fail("git ls-files failed: " + tracked.stderr.trim());
  files = tracked.stdout.split("\0").filter(Boolean);
  const dirty = git(["status", "--porcelain", "--ignored", "--untracked-files=all", "--", extDir]);
  if (dirty.status !== 0) fail("git status failed: " + dirty.stderr.trim());
  if (dirty.stdout.trim() && process.argv.indexOf("--allow-uncommitted") < 0)
    fail("the extension folder has changes that aren't committed (commit or remove them):\n" + dirty.stdout.trimEnd());
} else {
  const walk = dir => {
    let found = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      found = found.concat(e.isDirectory() ? walk(p) : [path.relative(ROOT, p)]);
    }
    return found;
  };
  files = walk(extDir);
  console.log("Not in a git clone of the repository: using every file in the extension folder.");
}

// --- build
removeDir(target);
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(path.join(__dirname, "spices", "info.json"), path.join(target, "info.json"));
fs.copyFileSync(path.join(__dirname, "spices", "README.md"), path.join(target, "README.md"));
fs.copyFileSync(screenshot, path.join(target, "screenshot.png"));
for (const f of files) {
  const d = path.join(target, "files", UUID, path.relative(extDir, path.join(ROOT, f)));
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), d);
}

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
console.log(`Next: copy it into your fork of linuxmint/cinnamon-spices-extensions, run ./validate-spice ${UUID} there, and open a pull request (DEVELOPMENT.md, section 9.2).`);
