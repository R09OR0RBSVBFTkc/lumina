/* 静态校验：检查 JS 引用的 DOM id、脚本/资源路径是否齐全。 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf-8');

const htmlIds = new Set();
const idRe = /id="([^"]+)"/g;
let m;
while ((m = idRe.exec(html))) htmlIds.add(m[1]);

const htmlUses = (html.match(/href="([^"]+)"/g) || []).concat(html.match(/src="([^"]+)"/g) || [])
  .map(s => s.slice(s.indexOf('"') + 1, -1))
  .filter(p => !p.startsWith('http') && !p.startsWith('data:'));

const jsFiles = fs.readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js'));
const jsIds = new Set();
for (const f of jsFiles) {
  const code = fs.readFileSync(path.join(root, 'js', f), 'utf-8');
  const re = /(?:getElementById|getElementsByTagName)?\s*\$\s*\(\s*['"]([^'"]+)['"]\s*\)|getElementById\(\s*['"]([^'"]+)['"]\s*\)/g;
  let x;
  while ((x = re.exec(code))) {
    const id = x[1] || x[2];
    if (id) jsIds.add(id);
  }
}

let problems = 0;
for (const id of jsIds) {
  if (!htmlIds.has(id)) {
    console.log('[MISSING-ID]', id, 'referenced in JS but not in index.html');
    problems++;
  }
}

for (const p of htmlUses) {
  const abs = path.join(root, p.split('?')[0].split('#')[0]);
  if (!fs.existsSync(abs)) {
    console.log('[MISSING-FILE]', p);
    problems++;
  }
}

const icons = ['icon-192.png', 'icon-256.png', 'icon-512.png', 'icon.ico'];
for (const i of icons) {
  if (!fs.existsSync(path.join(root, 'icons', i))) {
    console.log('[MISSING-ICON]', i);
    problems++;
  }
}

console.log('HTML ids:', htmlIds.size, '| JS-referenced ids:', jsIds.size, '| problems:', problems);
process.exit(problems ? 1 : 0);
