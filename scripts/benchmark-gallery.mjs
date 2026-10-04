// Synthetic derivation benchmark, not browser rendering or real-camera throughput.
// Optional first argument: path to a previous public/app.js for same-host comparison.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
const source = await readFile(process.argv[2] || new URL('../public/app.js', import.meta.url), 'utf8');
const photos = Array.from({ length: 50000 }, (_, i) => ({ id: String(i), folder: `${100 + Math.floor(i / 1000)}RICOH`, name: `R${String((i * 7919) % 50000).padStart(7, '0')}.JPG`, bytes: null, takenAt: null }));
const context = { state: { photos }, $: id => ({ value: id === 'sort' ? 'name-asc' : '' }), Intl };
vm.createContext(context);
const cacheSetup = source.includes('const photoNameCollator') ? source.slice(source.indexOf('const photoNameCollator'), source.indexOf('\nfunction element')) : '';
vm.runInContext(`${cacheSetup}\n${source.slice(source.indexOf('function knownSize'), source.indexOf('function dateLabel'))}\n${source.slice(source.indexOf('function filteredPhotos'), source.indexOf('function currentPage'))}`, context);
const samples = [];
for (let i = 0; i < 4; i++) {
  const start = performance.now();
  const list = vm.runInContext('filteredPhotos()', context);
  if (list.length !== 50000 || list[0].name !== 'R0000000.JPG') throw new Error('Unexpected gallery result');
  samples.push(Number((performance.now() - start).toFixed(3)));
}
console.log(JSON.stringify({ node: process.version, frames: photos.length, firstDerivationMs: samples[0], repeatedDerivationMs: samples.slice(1), scope: 'filter/sort derivation only; no DOM, camera, network or rendering' }, null, 2));
