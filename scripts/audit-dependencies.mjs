import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
// Deliberately narrow list: additions require reviewing upstream license text.
const approved = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Python-2.0', 'CC0-1.0', '(MIT OR CC0-1.0)']);
const failures = [];
let count = 0;
for (const [name, pkg] of Object.entries(lock.packages)) {
  if (!name) continue;
  count++;
  if (!approved.has(pkg.license)) failures.push(`${name}: unreviewed license ${pkg.license}`);
  if (!pkg.resolved?.startsWith('https://registry.npmjs.org/')) failures.push(`${name}: non-public npm source`);
  if (!pkg.integrity) failures.push(`${name}: missing integrity`);
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Dependency audit passed: ${count} packages, public npm sources and reviewed open-source licenses.`);
