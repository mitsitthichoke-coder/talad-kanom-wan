'use strict';
// Version bumper for ตลาดขนมหวาน. Version format: MM.mm.bbbb  (e.g. 01.00.0001)
//   node bump.js "ข้อความอัปเดต" "ข้อความที่สอง"   -> build +1 and add a patch-note entry
//   node bump.js --minor "..."                      -> minor +1, build reset to 0001
//   node bump.js --major "..."                      -> major +1, minor 00, build 0001
//   node bump.js --watch                            -> auto-bump the build number every time public/index.html is saved
// The version and patch notes live in public/index.html between the BUILD_START and BUILD_END markers.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const FILE = path.join(__dirname, 'public', 'index.html');
const RE = /\/\*BUILD_START\*\/const BUILD=([\s\S]*?);\/\*BUILD_END\*\//;
const pad = (n, w) => String(n).padStart(w, '0');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const notes = args.filter(a => !a.startsWith('--'));

function readBuild(src) {
  const m = RE.exec(src);
  if (!m) throw new Error('BUILD block not found in public/index.html');
  return JSON.parse(m[1]);
}
function nextVer(v, kind) {
  let [a, b, c] = v.split('.').map(Number);
  if (kind === 'major') { a++; b = 0; c = 1; } else if (kind === 'minor') { b++; c = 1; } else c++;
  return pad(a, 2) + '.' + pad(b, 2) + '.' + pad(c, 4);
}
const stripBuild = src => src.replace(RE, '');
function bump(kind, items, auto) {
  const src = fs.readFileSync(FILE, 'utf8'), build = readBuild(src);
  const ver = nextVer(build.ver, kind), d = new Date().toISOString().slice(0, 10);
  const entry = { v: ver, d, items: items.length ? items : ['ปรับปรุงทั่วไป'] };
  if (auto) entry.auto = true;
  if (auto && build.log[0] && build.log[0].auto) build.log[0] = entry; else build.log.unshift(entry);
  build.ver = ver; build.log = build.log.slice(0, 40);
  const out = src.replace(RE, () => '/*BUILD_START*/const BUILD=' + JSON.stringify(build, null, 1) + ';/*BUILD_END*/');
  fs.writeFileSync(FILE, out);
  return ver;
}
if (flag('--watch')) {
  let last = crypto.createHash('md5').update(stripBuild(fs.readFileSync(FILE, 'utf8'))).digest('hex'), t = null;
  console.log('watching public/index.html — version is bumped automatically on every save (Ctrl+C to stop)');
  fs.watch(FILE, () => {
    clearTimeout(t);
    t = setTimeout(() => {
      try {
        const h = crypto.createHash('md5').update(stripBuild(fs.readFileSync(FILE, 'utf8'))).digest('hex');
        if (h === last) return;                         // only the BUILD block changed (our own write)
        const v = bump('build', ['อัปเดตโค้ด (บันทึกอัตโนมัติ)'], true);
        last = crypto.createHash('md5').update(stripBuild(fs.readFileSync(FILE, 'utf8'))).digest('hex');
        console.log('Ver ' + v);
      } catch (e) { console.error(e.message); }
    }, 400);
  });
} else {
  console.log('Ver ' + bump(flag('--major') ? 'major' : flag('--minor') ? 'minor' : 'build', notes, false));
}
