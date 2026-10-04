import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function gallery(photos) {
  const controls = { search: '', folder: '', sort: 'newest' };
  let comparisons = 0;
  const context = {
    state: { photos, page: 1 }, $: id => ({ value: controls[id] }),
    Intl: { Collator: function(...args) {
      const collator = new Intl.Collator(...args);
      return { compare: (a, b) => { comparisons++; return collator.compare(a, b); } };
    } }
  };
  vm.createContext(context);
  // Exercise the production derivation without DOM/HTTP timing or a test-only app API.
  vm.runInContext(`const PAGE_SIZE = 24;\n${app.slice(app.indexOf('const photoNameCollator'), app.indexOf('\nfunction element'))}\n${app.slice(app.indexOf('function knownSize'), app.indexOf('function dateLabel'))}\n${app.slice(app.indexOf('function filteredPhotos'), app.indexOf('function toggleSelection'))}`, context);
  return { controls, state: context.state, list: () => vm.runInContext('filteredPhotos()', context), page: () => vm.runInContext('currentPage()', context), comparisons: () => comparisons };
}
const photo = (id, name, folder = '100RICOH', bytes = null, takenAt = null) => ({ id, name, folder, bytes, takenAt });
const ids = list => Array.from(list, item => item.id);

test('gallery: numeric filename sorting, folder ties and unknown metadata keep their ordering', () => {
  const g = gallery([photo('ten', 'R10.JPG'), photo('two-b', 'R2.JPG', '101RICOH'), photo('two-a', 'R2.JPG'), photo('one', 'R1.JPG', '100RICOH', 5, '2026-10-01')]);
  assert.deepEqual(ids(g.list()), ['one', 'two-a', 'two-b', 'ten']);
  g.controls.sort = 'name-asc'; assert.deepEqual(ids(g.list()), ['one', 'two-a', 'two-b', 'ten']);
  g.controls.sort = 'name-desc'; assert.deepEqual(ids(g.list()), ['ten', 'two-b', 'two-a', 'one']);
  g.controls.sort = 'size-desc'; assert.deepEqual(ids(g.list()), ['one', 'two-a', 'two-b', 'ten']);
  assert.deepEqual(ids(g.state.photos), ['ten', 'two-b', 'two-a', 'one'], 'Sorting never mutates source listing');
});

test('gallery: 50,000-frame card reuses one sorted list for selection and page navigation', () => {
  const g = gallery(Array.from({ length: 50000 }, (_, i) => photo(String(i), `R${(i * 7919) % 50000}.JPG`)));
  g.controls.sort = 'name-asc';
  const list = g.list(), comparisons = g.comparisons();
  assert.ok(comparisons > 0);
  for (let i = 0; i < 48; i++) {
    g.state.selected = new Set([String(i)]);
    assert.equal(g.list(), list);
    g.state.page = i + 1;
    assert.equal(g.page().visible.length, 24);
  }
  assert.equal(g.comparisons(), comparisons, 'Repeated interactions must do zero new sort comparisons');
  g.state.page = 9999;
  assert.equal(g.page().visible.length, 8);
  assert.equal(g.state.page, 2084);
});

test('gallery: search, folder, sorting, refresh and session replacement invalidate cached results', () => {
  const g = gallery([photo('a', 'R1.JPG'), photo('b', 'R2.JPG', '101RICOH')]);
  const original = g.list();
  g.controls.search = ' r1 '; assert.deepEqual(ids(g.list()), ['a']);
  g.controls.search = 'R1'; const normalized = g.list(); assert.equal(g.list(), normalized);
  g.controls.search = ''; g.controls.folder = '101RICOH'; assert.deepEqual(ids(g.list()), ['b']);
  g.controls.folder = ''; assert.deepEqual(ids(g.list()), ['a', 'b']);
  g.controls.sort = 'name-desc'; assert.deepEqual(ids(g.list()), ['b', 'a']);
  g.state.photos = [photo('replacement', 'R2.JPG', '101RICOH', 99)];
  assert.deepEqual(ids(g.list()), ['replacement']); assert.equal(g.list()[0].bytes, 99);
  assert.notEqual(g.list(), original);
  g.state.photos = []; assert.equal(g.page().visible.length, 0); assert.equal(g.state.page, 1);
});
