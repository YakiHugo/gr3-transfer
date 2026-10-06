// DOM interaction coverage, NOT browser rendering or real disk-download evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { createBridge } from '../src/server.js';
import { AppError, CameraAdapter } from '../src/camera.js';

const html = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8')).replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
const fileHelpers = await readFile(new URL('../public/transfer-files.js', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../fixtures/manifest.json', import.meta.url)));
const original = await readFile(new URL(`../fixtures/${manifest[0].id}.jpg`, import.meta.url));
async function until(predicate, message = 'UI state did not settle') {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > 2000) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function harness(t, { intercept, adapter, setup } = {}) {
  let cameraCalls = 0;
  const server = await createBridge({ adapter: adapter || { connect: async () => { cameraCalls++; throw new AppError('Synthetic offline camera. Join camera Wi-Fi and retry.', 'CAMERA_UNREACHABLE', 503); } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const window = new Window({ url: base });
  window.document.write(html);
  // happy-dom lacks the browser's Option constructor. Supply its DOM-equivalent.
  window.Option = function(text, value) { const node = window.document.createElement('option'); node.textContent = text; node.value = value; return node; };
  // Existing cleanup tests explicitly accept discard; guard-specific tests override this decision.
  window.confirm = () => true;
  window.AbortController = AbortController;
  window.DOMException = DOMException;
  window.Blob = Blob;
  let nextUrl = 0;
  const blobs = new Map(), revoked = [], saved = [], requests = [];
  window.URL.createObjectURL = blob => { const url = `blob:${base}/${++nextUrl}`; blobs.set(url, blob); return url; };
  window.URL.revokeObjectURL = url => { revoked.push(url); blobs.delete(url); };
  window.document.addEventListener('click', event => {
    const anchor = event.target.closest?.('a[download]');
    if (anchor) { event.preventDefault(); saved.push({ filename: anchor.download, blob: blobs.get(anchor.href) }); }
  });
  window.fetch = async (input, options = {}) => {
    const url = new URL(input, base); requests.push(url.pathname);
    const handled = await intercept?.(url, options);
    if (handled) return handled;
    return fetch(url, { ...options, headers: { ...options.headers, Origin: base } });
  };
  setup?.(window);
  window.eval(fileHelpers);
  window.eval(app);
  const $ = selector => window.document.querySelector(selector);
  const all = selector => [...window.document.querySelectorAll(selector)];
  const click = selector => { const node = $(selector); assert.ok(node, `Missing ${selector}`); node.click(); };
  const change = (selector, value, event = 'change') => { $(selector).value = value; $(selector).dispatchEvent(new window.Event(event, { bubbles: true })); };
  t.after(async () => { window.dispatchEvent(new window.Event('pagehide')); await window.happyDOM.close(); server.closeAllConnections(); server.close(); });
  await until(() => !$('#try-demo').disabled);
  return { window, $, all, click, change, blobs, revoked, saved, requests, cameraCalls: () => cameraCalls,
    demo: async () => { click('#try-demo'); await until(() => !$('#workspace').hidden && !$('#disconnect').disabled); } };
}

test('DOM: disconnected landing does not request camera or expose synthetic state as connected', async t => {
  const h = await harness(t);
  assert.equal(h.$('#landing').hidden, false); assert.equal(h.$('#workspace').hidden, true);
  assert.match(h.$('#connection-badge').textContent, /未连接/);
  assert.equal(h.cameraCalls(), 0); assert.deepEqual(h.requests, ['/api/session']);
});

test('DOM: demo gallery, folder/search filters, sorting, empty/reset and selection work', async t => {
  const h = await harness(t); await h.demo();
  assert.equal(h.all('.photo-card').length, 12, h.$('#notice-text').textContent); assert.equal(h.$('#demo-banner').hidden, false);
  assert.match(h.$('#connection-badge').textContent, /示例演示/);
  h.change('#folder', '100RICOH'); assert.equal(h.all('.photo-card').length, 6);
  h.change('#search', '0000001', 'input'); assert.equal(h.all('.photo-card').length, 1);
  h.click('#select-visible'); assert.equal(h.$('#selection-count').textContent, '1');
  h.change('#search', 'NO-MATCH', 'input'); assert.equal(h.$('#gallery-empty').hidden, false);
  h.click('#reset-filters'); assert.equal(h.all('.photo-card').length, 12);
  h.change('#sort', 'name-asc'); assert.match(h.$('.photo-meta h3').textContent, /R0000001/);
  assert.equal(h.$('#selection-count').textContent, '1'); h.click('#clear-selection'); assert.equal(h.$('#selection-count').textContent, '0');
});

test('DOM: preview uses preview derivative, supports repeated close/reopen and selection', async t => {
  const h = await harness(t); await h.demo();
  h.click('.photo-image-button'); assert.equal(h.$('#preview-dialog').open, true);
  assert.match(h.$('#preview-image').src, /\/preview\?session=/);
  assert.match(h.$('#preview-size').textContent, /KB/); assert.equal(h.$('#preview-synthetic').hidden, false);
  h.click('#preview-select'); assert.equal(h.$('#selection-count').textContent, '1');
  h.click('.preview-close'); assert.equal(h.$('#preview-dialog').open, false); assert.equal(h.window.document.body.classList.contains('has-modal'), false);
  h.click('.photo-image-button'); h.click('#preview-select'); assert.equal(h.$('#selection-count').textContent, '0');
});

test('DOM: original transfer creates unchanged Blob and save only reports browser handoff', async t => {
  const h = await harness(t); await h.demo(); h.change('#sort', 'name-asc');
  h.click('.photo-select input'); h.click('#transfer'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  assert.equal(h.all('.queue-item').length, 1); assert.equal(h.blobs.size, 1);
  assert.deepEqual(Buffer.from(await [...h.blobs.values()][0].arrayBuffer()), original);
  h.click('.queue-item-top button'); assert.equal(h.saved.length, 1); assert.equal(h.saved[0].filename, '8-100RICOH__R0000001.JPG');
  assert.match(h.$('.queue-item-status').textContent, /已交给浏览器/);
  h.click('.queue-remove'); assert.equal(h.blobs.size, 1); assert.equal(h.revoked.length, 1); // separate download lease remains briefly valid
});

test('DOM: sequential selected downloads, repeat-click deduplication and clear release all Blobs', async t => {
  const h = await harness(t); await h.demo(); h.change('#folder', '100RICOH');
  h.click('#select-visible'); h.click('#transfer');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 6);
  assert.equal(h.blobs.size, 6); h.click('#transfer'); assert.equal(h.all('.queue-item').length, 6);
  assert.match(h.$('#notice-text').textContent, /已在传输记录中/);
  h.click('#clear-queue'); assert.equal(h.blobs.size, 0); assert.equal(h.$('#queue-panel').hidden, true);
});

test('DOM: failed download is retryable and does not produce a saveable Blob', async t => {
  let attempts = 0;
  const h = await harness(t, { intercept: async url => {
    if (url.pathname.endsWith('/original') && ++attempts === 1) return new Response(JSON.stringify({ error: 'Synthetic interruption' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }});
  await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'failed');
  assert.equal(h.blobs.size, 0); assert.match(h.$('.queue-item-status').textContent, /操作未完成/);
  h.click('.queue-item-top button'); await until(() => h.$('.queue-item')?.dataset.state === 'ready'); assert.equal(attempts, 2);
});

test('DOM: interrupted reader cannot be saved; manual retries stop after three attempts', async t => {
  const h = await harness(t, { intercept: async url => {
    if (url.pathname.endsWith('/original')) return new Response(new ReadableStream({ start(c) { c.enqueue(original.subarray(0, 30)); c.error(new Error('Synthetic broken stream')); } }), { headers: { 'Content-Type': 'image/jpeg', 'X-File-Size': original.length } });
  }});
  await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  for (let i = 1; i <= 3; i++) {
    await until(() => h.$('.queue-item')?.dataset.state === 'failed');
    if (i < 3) h.click('.queue-item-top button');
  }
  assert.equal(h.blobs.size, 0); assert.equal(h.$('.queue-item-top button'), null);
  assert.match(h.$('.queue-item-status').textContent, /已达到重试上限/);
});

test('DOM: cancel aborts active stream and queued files without starting the next download', async t => {
  let reads = 0;
  const h = await harness(t, { intercept: async (url, opts) => {
    if (url.pathname.endsWith('/original')) {
      reads++;
      return new Response(new ReadableStream({ start(c) { c.enqueue(original.subarray(0, 30)); opts.signal.addEventListener('abort', () => c.error(new DOMException('cancelled', 'AbortError'))); } }), { headers: { 'Content-Type': 'image/jpeg', 'X-File-Size': original.length } });
    }
  }});
  await h.demo(); h.click('#select-visible'); h.click('#transfer'); await until(() => reads === 1);
  assert.equal(h.$('#disconnect').disabled, false); h.click('#cancel-queue');
  await until(() => h.all('.queue-item[data-state="cancelled"]').length === 12);
  assert.equal(reads, 1); assert.equal(h.blobs.size, 0); assert.equal(h.$('#disconnect').disabled, false);
});

test('DOM: declared size mismatch and oversized JPEG fail before Save', async t => {
  for (const size of [original.length + 1, 129 * 1024 * 1024]) {
    const h = await harness(t, { intercept: async url => url.pathname.endsWith('/original') ? new Response(original, { headers: { 'Content-Type': 'image/jpeg', 'X-File-Size': size } }) : undefined });
    await h.demo(); h.click('.photo-select input'); h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'failed');
    assert.equal(h.blobs.size, 0); assert.equal(h.$('.queue-item-top button')?.textContent, '重试');
  }
});

test('DOM: failed real-camera connection reconciles demo session and exposes honest error', async t => {
  const h = await harness(t); await h.demo(); h.click('#switch-camera'); h.click('#confirm-connect');
  await until(() => !h.$('#connect-error').hidden);
  assert.equal(h.cameraCalls(), 1); assert.equal(h.$('#landing').hidden, false); assert.equal(h.$('#workspace').hidden, true);
  assert.match(h.$('#connect-error').textContent, /无法连接相机/); assert.match(h.$('#connection-badge').textContent, /未连接/);
  h.click('#connect-dialog .close-dialog'); h.click('#try-demo'); await until(() => !h.$('#workspace').hidden);
});

test('DOM: large list paginates 24 frames, keeps cross-page selections and displays untrusted text safely', async t => {
  const h = await harness(t, { intercept: async url => {
    if (url.pathname === '/api/photos') return Response.json({ mode: 'demo', photos: Array.from({ length: 50 }, (_, i) => ({ id: i.toString(16).padStart(24, '0'), name: i ? `R${String(i).padStart(7, '0')}.JPG` : '<img src=x onerror=alert(1)>.JPG', folder: '100RICOH', bytes: null, width: null, height: null, takenAt: null, thumbnailUrl: '/missing', originalUrl: '/missing', synthetic: true })) });
  }});
  await h.demo(); assert.equal(h.all('.photo-card').length, 24); h.click('#select-visible');
  h.click('#pagination button:last-child'); assert.equal(h.all('.photo-card').length, 24); h.click('#select-visible'); assert.equal(h.$('#selection-count').textContent, '48');
  h.click('#pagination button:last-child'); assert.equal(h.all('.photo-card').length, 2); h.click('#select-visible'); h.click('#transfer');
  assert.match(h.$('#notice-text').textContent, /保留 48/); assert.equal(h.blobs.size, 0);
  h.change('#search', '<img', 'input'); assert.equal(h.all('.photo-card').length, 1); assert.equal(h.$('.photo-meta img'), null);
  assert.equal(h.$('.photo-meta h3').textContent, '<img src=x onerror=alert(1)>.JPG');
});

test('DOM: disconnect preserves completed originals; help states phone networking limit', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready'); h.click('#disconnect'); await until(() => !h.$('#landing').hidden);
  assert.equal(h.blobs.size, 1); assert.equal(h.$('#workspace').hidden, true);
  assert.equal(h.$('#offline-transfers').hidden, false);
  h.click('.queue-item-top button'); assert.equal(h.saved.length, 1);
  h.click('[data-help="phone"]'); assert.match(h.$('#help-content').textContent, /无法连接这台电脑/);
  h.click('#help-dialog .close-dialog'); assert.equal(h.window.document.body.classList.contains('has-modal'), false);
});

test('DOM: mobile transfer control selects originals and directs to transfer tray', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input');
  assert.equal(h.$('#mobile-selection').hidden, false); assert.equal(h.$('#mobile-selection-count').textContent, '1');
  h.click('#mobile-transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  assert.equal(h.blobs.size, 1); h.click('#clear-selection'); assert.equal(h.$('#mobile-selection').hidden, true);
});

test('DOM: unknown real-camera metadata remains explicitly unknown', async t => {
  const h = await harness(t, { intercept: async url => {
    if (url.pathname === '/api/photos') return Response.json({ mode: 'demo', photos: [{ id: '0'.repeat(24), name: 'R0000001.JPG', folder: '100RICOH', bytes: null, width: null, height: null, takenAt: null, thumbnailUrl: '/missing', originalUrl: '/missing', synthetic: false }] });
  }});
  await h.demo(); h.click('.photo-image-button');
  assert.equal(h.$('#preview-size').textContent, '大小未知'); assert.equal(h.$('#preview-dimensions').textContent, '未提供'); assert.equal(h.$('#preview-date').textContent, '未提供');
  assert.equal(h.$('#preview-synthetic').hidden, true);
});

test('DOM: Back/Forward restoration clears unusable Blob URLs and reconciles gallery', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  assert.equal(h.blobs.size, 0); assert.equal(h.all('.queue-item').length, 0);
  const event = new h.window.Event('pageshow'); Object.defineProperty(event, 'persisted', { value: true }); h.window.dispatchEvent(event);
  await until(() => h.all('.photo-card').length === 12 && !h.$('#disconnect').disabled);
  assert.equal(h.all('.queue-item').length, 0); assert.match(h.$('#notice-text').textContent, /清空|重新传输/i);
  h.click('.photo-select input'); h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'ready'); assert.equal(h.blobs.size, 1);
});

test('DOM: late old transfer cannot cancel a new tray after Back/Forward restore', async t => {
  let releaseOld, reads = 0;
  const h = await harness(t, { intercept: async url => {
    if (url.pathname.endsWith('/original')) {
      reads++;
      if (reads === 1) {
        let chunk = 0;
        return { ok: true, headers: new Headers({ 'Content-Type': 'image/jpeg', 'X-File-Size': String(original.length) }), body: { getReader: () => ({ read: async () => chunk++ === 0 ? { value: original.subarray(0, 30), done: false } : new Promise(resolve => { releaseOld = () => resolve({ done: true }); }), cancel: async () => {}, releaseLock: () => {} }) } };
      }
      return new Response(original, { headers: { 'Content-Type': 'image/jpeg', 'X-File-Size': original.length } });
    }
  }});
  await h.demo(); h.click('.photo-select input'); h.click('#transfer'); await until(() => typeof releaseOld === 'function');
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  const event = new h.window.Event('pageshow'); Object.defineProperty(event, 'persisted', { value: true }); h.window.dispatchEvent(event);
  await until(() => h.all('.photo-card').length === 12 && !h.$('#disconnect').disabled);
  h.click('.photo-select input'); h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  releaseOld(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.all('.queue-item').length, 1); assert.equal(h.$('.queue-item').dataset.state, 'ready'); assert.equal(h.blobs.size, 1);
});

test('DOM: disconnect during batch cancels the active file and preserves already completed originals offline', async t => {
  let reads = 0;
  const h = await harness(t, { intercept: async (url, opts) => {
    if (url.pathname.endsWith('/original') && ++reads === 2) return new Response(new ReadableStream({ start(c) { c.enqueue(original.subarray(0, 30)); opts.signal.addEventListener('abort', () => c.error(new DOMException('cancelled', 'AbortError'))); } }), { headers: { 'Content-Type': 'image/jpeg', 'X-File-Size': original.length } });
  }});
  await h.demo(); h.click('#select-visible'); h.click('#transfer'); await until(() => reads === 2);
  h.click('#disconnect'); await until(() => !h.$('#landing').hidden && !h.$('#disconnect').disabled);
  assert.equal(h.all('.queue-item[data-state="ready"]').length, 1); assert.equal(h.all('.queue-item[data-state="cancelled"]').length, 11);
  assert.equal(h.$('#offline-transfers').hidden, false); assert.equal(h.blobs.size, 1);
  assert.equal(h.all('.queue-item button[aria-label^="重试"]').length, 0);
  h.click('.queue-item[data-state="ready"] .queue-item-top button'); assert.equal(h.saved.length, 1);
});

test('DOM: reconnect permits same file ID from a new source session without discarding old completed files', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  h.click('#disconnect'); await until(() => !h.$('#landing').hidden && !h.$('#disconnect').disabled);
  h.click('#try-demo'); await until(() => !h.$('#workspace').hidden && !h.$('#disconnect').disabled);
  assert.equal(h.blobs.size, 1); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 2);
  assert.equal(h.blobs.size, 2); assert.equal(h.$('#offline-transfers').hidden, true);
});

test('DOM: failed camera switch retains previously completed demo originals for saving', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  h.click('#switch-camera'); h.click('#confirm-connect'); await until(() => !h.$('#connect-error').hidden);
  h.click('#connect-dialog .close-dialog'); assert.equal(h.$('#offline-transfers').hidden, false); assert.equal(h.blobs.size, 1);
  h.click('.queue-item-top button'); assert.equal(h.saved.length, 1);
});

test('DOM: stale source errors are not offered as blindly repeatable retries', async t => {
  const h = await harness(t, { intercept: async url => url.pathname.endsWith('/original') ? Response.json({ error: 'Gallery session ended.', code: 'STALE_SESSION' }, { status: 409 }) : undefined });
  await h.demo(); h.click('.photo-select input'); h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'failed');
  assert.equal(h.$('.queue-item-top button'), null); assert.match(h.$('.queue-item-status').textContent, /重新连接并选择/);
});

test('DOM: ZIP creation, explicit save handoff, offline save and clear release archive plus originals', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  assert.equal(h.blobs.size, 2); assert.match(h.$('#archive-status').textContent, /SHA-256 清单/);
  h.click('#disconnect'); await until(() => !h.$('#landing').hidden && !h.$('#disconnect').disabled);
  h.click('#save-archive'); assert.equal(h.saved.length, 1); assert.match(h.saved[0].filename, /^gr3-originals-.*\.zip$/);
  assert.equal(h.saved[0].blob.type, 'application/zip'); assert.match(h.$('#archive-status').textContent, /无法确认是否已写入磁盘/);
  h.click('#clear-queue'); assert.equal(h.blobs.size, 1); assert.equal(h.$('#offline-transfers').hidden, true); // ZIP handoff lease survives clear
});

test('DOM: failed Blob URL allocation cannot create an unaccounted archive-eligible transfer', async t => {
  const h = await harness(t); await h.demo();
  const create = h.window.URL.createObjectURL; h.window.URL.createObjectURL = () => { throw new Error('Synthetic URL allocation failure'); };
  h.click('.photo-select input'); h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'failed');
  assert.equal(h.blobs.size, 0); assert.equal(h.$('#build-archive').disabled, true); assert.equal(h.$('.queue-save-name'), null);
  h.window.URL.createObjectURL = create; h.click('.queue-item-top button'); await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  assert.equal(h.blobs.size, 1); h.click('#clear-queue'); assert.equal(h.blobs.size, 0);
});

test('DOM: cancelling ZIP preparation keeps ready originals and permits a later ZIP retry', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  const originalHelpers = h.window.GRTransferFiles;
  h.window.GRTransferFiles = { ...originalHelpers, buildArchive: (_entries, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))) };
  h.click('#build-archive'); assert.equal(h.$('#cancel-archive').hidden, false); h.click('#cancel-archive'); await until(() => h.$('#cancel-archive').hidden);
  assert.equal(h.blobs.size, 1); assert.match(h.$('#archive-status').textContent, /取消.*仍可单独保存/);
  h.window.GRTransferFiles = originalHelpers; h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden); assert.equal(h.blobs.size, 2);
});

test('DOM: clearing immediately after Save ZIP preserves a bounded download URL until grace expiry', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  const timers = []; const set = h.window.setTimeout.bind(h.window);
  h.window.setTimeout = (fn, ms, ...args) => ms === 30000 ? (timers.push(fn), timers.length) : set(fn, ms, ...args);
  h.click('#save-archive'); const savedBlob = h.saved[0].blob;
  h.click('#clear-queue'); assert.equal(h.blobs.size, 1); assert.ok([...h.blobs.values()].includes(savedBlob));
  timers.forEach(fn => fn()); assert.equal(h.blobs.size, 0);
});

test('DOM: repeated individual Save reuses its download lease instead of retaining duplicate URLs', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  h.click('.queue-item-top button'); assert.equal(h.blobs.size, 2);
  h.click('.queue-item-top button'); assert.equal(h.blobs.size, 2); assert.equal(h.saved.length, 2);
  assert.equal(h.saved[0].blob, h.saved[1].blob);
});

test('DOM: retrying a failed file invalidates a previously prepared partial ZIP', async t => {
  let attempts = 0;
  const h = await harness(t, { intercept: async url => {
    if (url.pathname.endsWith('/original') && ++attempts === 2) return Response.json({ error: 'Synthetic transient failure' }, { status: 503 });
  }});
  await h.demo(); h.change('#folder', '100RICOH'); h.click('#select-visible'); h.click('#transfer');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 5 && h.all('.queue-item[data-state="failed"]').length === 1 && !h.$('#build-archive').disabled);
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  assert.match(h.$('#archive-status').textContent, /5 张原片/);
  h.click('.queue-item[data-state="failed"] .queue-item-top button');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 6);
  assert.equal(h.$('#save-archive').hidden, true, 'The old partial ZIP must not remain saveable after a new successful retry');
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  assert.match(h.$('#archive-status').textContent, /6 张原片/);
});


test('DOM: two complete sessions retain a 24-JPEG ZIP through disconnect and clear', async t => {
  const h = await harness(t);
  for (let session = 1; session <= 2; session++) {
    await h.demo(); h.click('#select-visible'); h.click('#transfer');
    await until(() => h.all('.queue-item[data-state="ready"]').length === session * 12);
    h.click('#disconnect'); await until(() => !h.$('#landing').hidden && !h.$('#disconnect').disabled);
  }
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  h.click('#save-archive'); assert.equal(h.saved.length, 1);
  assert.match(h.$('#archive-status').textContent, /24 张原片/);
  const payload = Buffer.from(await h.saved[0].blob.arrayBuffer());
  h.click('#clear-queue'); assert.equal(h.blobs.size, 1);
  assert.deepEqual(Buffer.from(await h.saved[0].blob.arrayBuffer()), payload);
  // Optional independent decoder audit; ordinary npm checks remain Node-only.
  if (process.env.RUN_PYTHON_ZIP_AUDIT !== '1') return;
  const result = execFileSync('python3', ['-c', `
import sys, io, zipfile, json, hashlib, pathlib
fixtures = pathlib.Path(sys.argv[1])
source = {(x['folder'], x['name']): (fixtures / (x['id'] + '.jpg')).read_bytes() for x in json.loads((fixtures / 'manifest.json').read_text())}
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.testzip() is None
    manifest = json.loads(archive.read('transfer-manifest.json'))
    assert len(manifest['files']) == 24
    assert len(archive.namelist()) == 25
    assert len(set(archive.namelist())) == 25
    assert {x['source']['index'] for x in manifest['files']} == {1, 2}
    for item in manifest['files']:
        data = archive.read(item['path'])
        assert data == source[item['cameraFolder'], item['cameraFilename']]
        assert item['bytes'] == len(data)
        assert item['sha256'] == hashlib.sha256(data).hexdigest()
        assert item['source']['hardwareVerified'] is False
        assert item['path'].startswith('source-%02d/' % item['source']['index'])
print('24 original JPEGs: CRC, exact bytes, SHA-256, separate source paths passed')
`, fileURLToPath(new URL('../fixtures/', import.meta.url))], { input: payload, encoding: 'utf8' });
  assert.match(result, /24 original JPEGs.*passed/);
});

test('DOM: cancelled active transfer retries without restarting the remaining cancelled files', async t => {
  let reads = 0;
  const h = await harness(t, { intercept: async (url, opts) => {
    if (url.pathname.endsWith('/original') && ++reads === 1) return new Response(new ReadableStream({ start(c) {
      c.enqueue(original.subarray(0, 30));
      opts.signal.addEventListener('abort', () => c.error(new DOMException('cancelled', 'AbortError')));
    } }), { headers: { 'Content-Type': 'image/jpeg', 'X-File-Size': original.length } });
  }});
  await h.demo(); h.click('#select-visible'); h.click('#transfer'); await until(() => reads === 1);
  h.click('#cancel-queue'); await until(() => h.all('.queue-item[data-state="cancelled"]').length === 12 && !h.$('#transfer').disabled);
  h.click('.queue-item[data-state="cancelled"] .queue-item-top button');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 1);
  assert.equal(reads, 2); assert.equal(h.all('.queue-item[data-state="cancelled"]').length, 11);
  h.click('.queue-item[data-state="ready"] .queue-item-top button');
  const photo = manifest.find(photo => h.saved[0].filename.endsWith(photo.folder + '__' + photo.name));
  assert.ok(photo);
  assert.deepEqual(Buffer.from(await h.saved[0].blob.arrayBuffer()), await readFile(new URL('../fixtures/' + photo.id + '.jpg', import.meta.url)));
});

test('DOM: archive allocation failure leaves originals intact and allows packaging retry', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  const create = h.window.URL.createObjectURL;
  h.window.URL.createObjectURL = blob => { if (blob.type === 'application/zip') throw new Error('Synthetic archive URL failure'); return create(blob); };
  h.click('#build-archive'); await until(() => /打包失败/.test(h.$('#archive-status').textContent));
  assert.equal(h.blobs.size, 1); assert.equal(h.$('#save-archive').hidden, true); assert.equal(h.$('#build-archive').disabled, false);
  h.window.URL.createObjectURL = create; h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  assert.equal(h.blobs.size, 2);
});

test('DOM: one-click batch retry restores cancelled remainder, keeps ready bytes and rejects duplicate clicks', async t => {
  const reads = new Map();
  let interruptedUrl;
  const h = await harness(t, { intercept: async (url, opts) => {
    if (!url.pathname.endsWith('/original')) return;
    const count = (reads.get(url.href) || 0) + 1; reads.set(url.href, count);
    if (reads.size === 2 && count === 1) {
      interruptedUrl = url.href;
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(original.subarray(0, 30));
        opts.signal.addEventListener('abort', () => c.error(new DOMException('cancelled', 'AbortError')));
      } }), { headers: { 'Content-Type': 'image/jpeg' } });
    }
  }});
  await h.demo(); h.click('#select-visible'); h.click('#transfer');
  await until(() => interruptedUrl && h.all('.queue-item[data-state="ready"]').length === 1);
  const readyBlob = [...h.blobs.values()][0];
  h.click('#cancel-queue'); await until(() => !h.$('#retry-unfinished').disabled);
  assert.equal(h.all('.queue-item[data-state="cancelled"]').length, 11);
  assert.match(h.$('#queue-summary').textContent, /1 张待保存.*11 张已取消/);
  assert.equal(h.$('#retry-unfinished').textContent, '重试未完成项（11）');
  assert.match(h.$('#recovery-note').textContent, /从头重试.*失败或取消.*已完成原片会保留/);
  const button = h.$('#retry-unfinished'); button.click();
  // Dispatch bypasses native disabled-button click suppression to test the running guard too.
  button.dispatchEvent(new h.window.Event('click'));
  await until(() => h.all('.queue-item[data-state="ready"]').length === 12 && !h.$('#build-archive').disabled);
  assert.equal(reads.size, 12); assert.equal([...reads.values()].reduce((sum, n) => sum + n, 0), 13);
  assert.equal(reads.get(interruptedUrl), 2);
  assert.ok([...h.blobs.values()].includes(readyBlob), 'Completed JPEG Blob is retained, not downloaded again');
  assert.equal(h.$('#queue-recovery').hidden, true); assert.equal(h.$('#retry-unfinished').disabled, true);
  assert.equal(h.$('#queue-summary').textContent, '12 张待保存');
  for (const save of h.all('.queue-item-top button')) save.click();
  assert.equal(h.saved.length, 12);
  for (const saved of h.saved) {
    const photo = manifest.find(photo => saved.filename.endsWith(photo.folder + '__' + photo.name));
    assert.ok(photo);
    assert.deepEqual(Buffer.from(await saved.blob.arrayBuffer()), await readFile(new URL('../fixtures/' + photo.id + '.jpg', import.meta.url)));
  }
});

test('DOM: batch retry excludes old sessions, stale responses and exhausted entries in a mixed tray', async t => {
  let phase = 'old';
  const reads = new Map();
  const h = await harness(t, { intercept: async url => {
    if (!url.pathname.endsWith('/original')) return;
    const key = `${phase}:${url.pathname}`;
    const count = (reads.get(key) || 0) + 1; reads.set(key, count);
    if (phase === 'old' || url.pathname.includes(manifest[0].id) || (url.pathname.includes(manifest[1].id) && count === 1)) return Response.json({ error: 'Synthetic interrupted read' }, { status: 503 });
    if (url.pathname.includes(manifest[2].id)) return Response.json({ error: 'Synthetic stale URL', code: 'STALE_SESSION' }, { status: 409 });
  }});
  await h.demo(); h.change('#sort', 'name-asc'); h.click('.photo-select input'); h.click('#transfer');
  await until(() => !h.$('#retry-unfinished').disabled);
  const oldRetry = h.$('#queue-1 button[aria-label^="重试"]');
  h.click('#disconnect'); await until(() => !h.$('#landing').hidden && !h.$('#disconnect').disabled);
  assert.equal(h.$('#retry-unfinished').hidden, true); assert.equal(h.$('#retry-unfinished').disabled, true);
  phase = 'current'; await h.demo(); h.change('#folder', '100RICOH'); h.click('#select-visible'); h.click('#transfer');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 3 && !h.$('#build-archive').disabled);
  const exhaustedRetry = h.$('#queue-2 button[aria-label^="重试"]');
  for (let attempt = 2; attempt <= 3; attempt++) {
    h.click('#queue-2 button[aria-label^="重试"]');
    await until(() => h.$('#queue-2').dataset.state === 'failed' && !h.$('#build-archive').disabled);
  }
  assert.equal(h.$('#retry-unfinished').textContent, '重试未完成项（1）');
  assert.match(h.$('#recovery-note').textContent, /1 项的来源已断开或变更/);
  assert.match(h.$('#recovery-note').textContent, /1 项在本次连接中已失效/);
  assert.match(h.$('#recovery-note').textContent, /1 项已达到 3 次尝试上限/);
  const before = new Map(reads);
  oldRetry.click(); exhaustedRetry.click();
  assert.deepEqual(reads, before, 'Detached individual retry controls cannot revive stale or exhausted entries');
  h.click('#retry-unfinished'); await until(() => h.all('.queue-item[data-state="ready"]').length === 4 && !h.$('#build-archive').disabled);
  for (const [key, count] of reads) assert.equal(count, before.get(key) + (key.includes(manifest[1].id) ? 1 : 0));
  assert.equal(h.all('.queue-item[data-state="failed"]').length, 3);
  assert.equal(h.$('#retry-unfinished').hidden, true); assert.equal(h.$('#retry-unfinished').disabled, true);
  assert.equal(h.$('#queue-recovery').hidden, false);
});

test('DOM: batch retry invalidates partial ZIP and preserves already handed-off JPEGs', async t => {
  let reads = 0;
  const h = await harness(t, { intercept: async url => {
    if (url.pathname.endsWith('/original') && [2, 4].includes(++reads)) return Response.json({ error: 'Synthetic transient failure' }, { status: 503 });
  }});
  await h.demo(); h.change('#folder', '100RICOH'); h.click('#select-visible'); h.click('#transfer');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 4 && !h.$('#build-archive').disabled);
  h.click('.queue-item[data-state="ready"] .queue-item-top button'); const saved = h.saved[0].blob;
  assert.match(h.$('#queue-summary').textContent, /3 张待保存.*1 张已交给浏览器.*2 张失败/);
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  const oldZip = [...h.blobs.entries()].find(([, blob]) => blob.type === 'application/zip')[0];
  assert.match(h.$('#archive-status').textContent, /4 张原片/);
  h.click('#retry-unfinished'); assert.equal(h.$('#save-archive').hidden, true); assert.ok(h.revoked.includes(oldZip));
  await until(() => h.all('.queue-item[data-state="ready"]').length === 5 && !h.$('#build-archive').disabled);
  assert.equal(reads, 8); assert.equal(h.all('.queue-item[data-state="handed-off"]').length, 1);
  assert.ok([...h.blobs.values()].includes(saved));
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  assert.match(h.$('#archive-status').textContent, /6 张原片/);
});

test('DOM: retry recovery is disabled during ZIP preparation and clearing removes recovery controls', async t => {
  let reads = 0;
  const h = await harness(t, { intercept: async url => {
    if (url.pathname.endsWith('/original') && ++reads === 2) return Response.json({ error: 'Synthetic transient failure' }, { status: 503 });
  }});
  await h.demo(); h.change('#folder', '100RICOH'); h.click('#select-visible'); h.click('#transfer');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 5 && !h.$('#build-archive').disabled);
  const button = h.$('#retry-unfinished');
  h.window.GRTransferFiles = { ...h.window.GRTransferFiles, buildArchive: (_entries, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))) };
  h.click('#build-archive'); assert.equal(button.disabled, true);
  button.dispatchEvent(new h.window.Event('click')); assert.equal(reads, 6);
  h.click('#cancel-archive'); await until(() => !button.disabled);
  h.click('#clear-queue'); assert.equal(h.$('#queue-recovery').hidden, true); assert.equal(button.hidden, true); assert.equal(button.disabled, true);
  button.dispatchEvent(new h.window.Event('click')); assert.equal(reads, 6); assert.equal(h.blobs.size, 0);
});

test('DOM: repeated cancellation respects the three-attempt cap and leaves unattempted frames retryable', async t => {
  let reads = 0;
  const h = await harness(t, { intercept: async (url, opts) => {
    if (!url.pathname.endsWith('/original')) return;
    reads++;
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(original.subarray(0, 30));
      opts.signal.addEventListener('abort', () => c.error(new DOMException('cancelled', 'AbortError')));
    } }), { headers: { 'Content-Type': 'image/jpeg' } });
  }});
  await h.demo(); h.click('#select-visible'); h.click('#transfer');
  for (let attempt = 1; attempt <= 3; attempt++) {
    await until(() => reads === attempt && !h.$('#cancel-queue').disabled);
    h.click('#cancel-queue'); await until(() => h.all('.queue-item[data-state="cancelled"]').length === 12 && !h.$('#retry-unfinished').disabled);
    if (attempt < 3) h.click('#retry-unfinished');
  }
  assert.equal(h.$('#retry-unfinished').textContent, '重试未完成项（11）');
  assert.equal(h.$('#queue-1 button[aria-label^="重试"]'), null);
  assert.match(h.$('#queue-1 .queue-item-status').textContent, /已达到重试上限/);
  assert.match(h.$('#recovery-note').textContent, /1 项已达到 3 次尝试上限/);
  assert.equal(reads, 3); assert.equal(h.blobs.size, 0);
});

test('DOM: synthetic camera-protocol interruption recovers only missing originals with unchanged JPEG bytes', async t => {
  const calls = [], reads = new Map();
  const photos = manifest.slice(0, 3);
  const adapter = new CameraAdapter({ fetchImpl: async (input, options) => {
    const url = new URL(input); calls.push({ path: url.pathname + url.search, method: options.method });
    if (url.pathname === '/v1/props') return Response.json({ model: 'RICOH GR III', firmwareVersion: 'synthetic' });
    if (url.pathname === '/v1/photos') return Response.json({ dirs: [{ name: '100RICOH', files: photos.map(photo => photo.name) }] });
    const photo = photos.find(photo => url.pathname === `/v1/photos/${photo.folder}/${photo.name}`);
    assert.ok(photo, 'Synthetic adapter rejects unrecognized paths');
    assert.equal(url.search, '', 'Recovered originals cannot use a resized variant');
    const count = (reads.get(photo.id) || 0) + 1; reads.set(photo.id, count);
    if (photo.id === photos[1].id && count === 1) throw new Error('Synthetic Wi-Fi interruption');
    const payload = await readFile(new URL('../fixtures/' + photo.id + '.jpg', import.meta.url));
    return new Response(payload, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(payload.length) } });
  }});
  const h = await harness(t, { adapter });
  h.click('#landing-connect'); h.click('#confirm-connect');
  await until(() => !h.$('#workspace').hidden && !h.$('#disconnect').disabled);
  assert.match(h.$('#connection-badge').textContent, /已连接.*待实机验证/);
  h.click('#select-visible'); h.click('#transfer');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 2 && !h.$('#retry-unfinished').disabled);
  assert.match(h.$('#recovery-note').textContent, /先恢复相机 Wi-Fi/);
  h.click('#retry-unfinished'); await until(() => h.all('.queue-item[data-state="ready"]').length === 3 && !h.$('#build-archive').disabled);
  assert.equal(reads.get(photos[0].id), 1); assert.equal(reads.get(photos[1].id), 2); assert.equal(reads.get(photos[2].id), 1);
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(calls.length, 6, 'Only props, list, three originals and one retry are read');
  for (const save of h.all('.queue-item-top button')) save.click();
  for (const saved of h.saved) {
    const photo = photos.find(photo => saved.filename.endsWith(photo.folder + '__' + photo.name));
    assert.ok(photo);
    assert.deepEqual(Buffer.from(await saved.blob.arrayBuffer()), await readFile(new URL('../fixtures/' + photo.id + '.jpg', import.meta.url)));
  }
});

test('DOM: saved partial ZIP lease survives batch retry, rebuilt ZIP and clear, then expires', async t => {
  let reads = 0;
  const h = await harness(t, { intercept: async url => {
    if (url.pathname.endsWith('/original') && ++reads === 2) return Response.json({ error: 'Synthetic interruption' }, { status: 503 });
  }});
  await h.demo(); h.change('#folder', '100RICOH'); h.click('#select-visible'); h.click('#transfer');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 5 && !h.$('#build-archive').disabled);
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  const originalSetTimeout = h.window.setTimeout.bind(h.window), timers = [];
  h.window.setTimeout = (fn, ms, ...args) => ms === 30000 ? (timers.push(fn), timers.length) : originalSetTimeout(fn, ms, ...args);
  const archiveUrl = [...h.blobs.entries()].find(([,blob]) => blob.type === 'application/zip')[0];
  h.click('#save-archive'); const oldZip = h.saved[0].blob;
  const leaseUrl = [...h.blobs.entries()].find(([url,blob]) => blob === oldZip && url !== archiveUrl)[0];
  h.click('#retry-unfinished');
  assert.equal(h.$('#save-archive').hidden, true);
  assert.ok(h.revoked.includes(archiveUrl)); assert.ok(!h.revoked.includes(leaseUrl));
  await until(() => h.all('.queue-item[data-state="ready"]').length === 6 && !h.$('#build-archive').disabled);
  assert.ok(h.blobs.has(leaseUrl));
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  h.click('#save-archive'); const newZip = h.saved[1].blob;
  assert.notEqual(oldZip, newZip); assert.ok(newZip.size > oldZip.size);
  h.click('#clear-queue'); assert.equal(h.blobs.size, 2);
  assert.deepEqual(new Set(h.blobs.values()), new Set([oldZip,newZip]));
  timers.forEach(fn => fn()); assert.equal(h.blobs.size, 0);
});

test('DOM: removed individual retry handle cannot queue detached entry', async t => {
  let reads = 0;
  const h = await harness(t, { intercept: async url => {
    if (url.pathname.endsWith('/original')) { reads++; return Response.json({ error: 'Synthetic interruption' }, { status: 503 }); }
  }});
  await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => !h.$('#retry-unfinished').disabled);
  const oldRetry = h.$('.queue-item-top button');
  h.click('.queue-remove'); oldRetry.dispatchEvent(new h.window.Event('click'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(reads, 1); assert.equal(h.all('.queue-item').length, 0); assert.equal(h.blobs.size, 0);
});

test('DOM: delayed aborted transfer cleanup must not overwrite retry after failed disconnect', async t => {
  let reads = 0, releaseOldCancel;
  const h = await harness(t, { intercept: async (url, opts) => {
    if (url.pathname === '/api/disconnect') return Response.json({error:'Synthetic disconnect failure'}, {status:503});
    if (!url.pathname.endsWith('/original')) return;
    reads++;
    if (reads > 1) return;
    let chunk = 0;
    return {ok: true, headers:new Headers({'Content-Type':'image/jpeg','X-File-Size':String(original.length)}), body:{getReader:()=>({
      read:async()=> chunk++ === 0 ? {value:original.subarray(0,30),done:false} : new Promise((_,reject)=> opts.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')))),
      cancel:async()=>new Promise(resolve=>{releaseOldCancel=resolve;}), releaseLock:()=>{}
    })}};
  }});
  await h.demo(); h.click('.photo-select input'); h.click('#transfer'); await until(()=>reads === 1);
  h.click('#disconnect'); await until(()=>!h.$('#retry-unfinished').disabled && releaseOldCancel);
  h.click('#retry-unfinished'); await until(()=>h.$('.queue-item')?.dataset.state === 'ready' && !h.$('#build-archive').disabled);
  releaseOldCancel(); await new Promise(resolve=>setTimeout(resolve,10));
  h.click('#build-archive'); await until(()=>!h.$('#save-archive').hidden);
  assert.equal(h.$('.queue-item').dataset.state, 'ready');
  assert.ok(h.$('.queue-item-top button[aria-label^="保存"]'));
});

test('DOM: cached gallery refresh replaces metadata, prunes removed selections and clamps the page', async t => {
  let photos = Array.from({ length: 50 }, (_, i) => ({ ...manifest[0], id: String(i), name: `R${String(i).padStart(7, '0')}.JPG` }));
  const h = await harness(t, { intercept: async url => {
    if (['/api/photos', '/api/refresh'].includes(url.pathname)) return Response.json({ photos });
  }});
  await h.demo();
  h.change('#sort', 'name-asc');
  h.click('#select-visible');
  h.click('#pagination button:last-child'); h.click('#select-visible');
  assert.equal(h.$('#selection-count').textContent, '48');
  h.click('#pagination button:last-child'); assert.equal(h.all('.photo-card').length, 2);
  photos = [{ ...photos[0], name: 'REPLACED.JPG', bytes: 2048 }];
  h.click('#refresh'); await until(() => !h.$('#refresh').disabled);
  assert.equal(h.all('.photo-card').length, 1);
  assert.equal(h.$('.photo-meta h3').textContent, 'REPLACED.JPG');
  assert.match(h.$('.photo-meta p').textContent, /2 KB/);
  assert.equal(h.$('#selection-count').textContent, '1');
  assert.equal(h.$('#pagination').hidden, true);
  h.change('#search', 'R000', 'input'); assert.equal(h.all('.photo-card').length, 0);
  h.click('#reset-filters'); assert.equal(h.$('.photo-meta h3').textContent, 'REPLACED.JPG');
  h.click('#disconnect'); await until(() => !h.$('#try-demo').disabled);
  photos = [{ ...photos[0], id: 'new-session', name: 'NEW.JPG' }];
  await h.demo(); assert.equal(h.$('.photo-meta h3').textContent, 'NEW.JPG');
  assert.equal(h.$('#selection-count').textContent, '0');
});

test('DOM: structured connection failures show relevant recovery steps and retry clears them', async t => {
  const h = await harness(t, { adapter: { connect: async () => { throw new AppError('Different model', 'WRONG_MODEL', 409); } } });
  h.click('#landing-connect'); h.click('#confirm-connect');
  await until(() => !h.$('#connect-error').hidden);
  assert.match(h.$('#connect-recovery').textContent, /仅支持设备型号为 RICOH GR III/);
  assert.equal(h.$('#connect-recovery').hidden, false);
  h.click('#confirm-connect');
  assert.equal(h.$('#connect-recovery').hidden, true);
  await until(() => !h.$('#connect-error').hidden);
  assert.equal(h.cameraCalls(), 0);
});

test('DOM: closing a pending connection cancels upstream and never resurrects the gallery', async t => {
  let entered = false, cancelled = false, finish;
  const h = await harness(t, { adapter: { connect: signal => {
    entered = true;
    signal.addEventListener('abort', () => { cancelled = true; });
    return new Promise(resolve => { finish = () => resolve({ properties: { model: 'RICOH GR III' }, photos: [] }); });
  } } });
  await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  h.click('#switch-camera'); h.click('#confirm-connect');
  await until(() => entered);
  assert.equal(h.$('#cancel-connect').hidden, false);
  h.click('#cancel-connect'); h.click('#cancel-connect');
  await until(() => !h.$('#try-demo').disabled && cancelled);
  assert.equal(h.$('#connect-dialog').open, false);
  assert.equal(h.$('#workspace').hidden, true);
  assert.equal(h.$('.queue-item').dataset.state, 'ready');
  finish(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.$('#workspace').hidden, true);
  assert.match(h.$('#notice-text').textContent, /已取消连接/);
  await h.demo(); assert.equal(h.$('#workspace').hidden, false);
});

test('DOM: Escape cancels pending camera connection and allows another attempt', async t => {
  let entered = false;
  const h = await harness(t, { adapter: { connect: signal => new Promise((resolve, reject) => {
    entered = true; signal.addEventListener('abort', () => reject(signal.reason));
  }) } });
  h.click('#landing-connect'); h.click('#confirm-connect'); await until(() => entered);
  h.$('#connect-dialog').dispatchEvent(new h.window.Event('cancel'));
  await until(() => !h.$('#try-demo').disabled);
  assert.equal(h.$('#workspace').hidden, true);
  h.click('#connect-dialog .close-dialog'); await h.demo();
});

test('DOM: selection review retains hidden selections and deselects only the visible subset', async t => {
  const h = await harness(t); await h.demo();
  h.click('#select-visible'); assert.equal(h.$('#selection-count').textContent, '12');
  h.change('#folder', '100RICOH');
  assert.match(h.$('#selection-visibility').textContent, /本页已选 6 张 · 其他页 6 张/);
  h.click('#selected-only'); assert.equal(h.all('.photo-card').length, 6);
  h.click('#deselect-visible'); assert.equal(h.$('#selection-count').textContent, '6');
  assert.equal(h.all('.photo-card').length, 0);
  assert.match(h.$('#empty-description').textContent, /已选照片中没有符合/);
  h.click('#reset-filters'); assert.equal(h.all('.photo-card').length, 12);
  assert.equal(h.$('#selected-only').checked, false);
  h.click('#selected-only'); assert.equal(h.all('.photo-card').length, 6);
  h.click('.photo-select input'); assert.equal(h.all('.photo-card').length, 5);
  h.click('#clear-selection'); assert.equal(h.all('.photo-card').length, 0);
  assert.equal(h.$('#deselect-visible').disabled, true);
  assert.equal(h.$('#transfer').disabled, true);
});

test('DOM: preview previous/next and arrow keys follow filtered order without changing selection', async t => {
  const h = await harness(t); await h.demo(); h.change('#folder', '100RICOH'); h.change('#sort', 'name-asc');
  h.click('.photo-image-button'); const first = h.$('#preview-title').textContent;
  assert.equal(h.$('#preview-previous').disabled, true); assert.equal(h.$('#preview-position').textContent, '1 / 6');
  h.click('#preview-select'); h.click('#preview-next');
  assert.notEqual(h.$('#preview-title').textContent, first); assert.equal(h.$('#selection-count').textContent, '1');
  h.$('#preview-dialog').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(h.$('#preview-title').textContent, first);
  for (let i = 0; i < 7; i++) h.click('#preview-next');
  assert.equal(h.$('#preview-position').textContent, '6 / 6'); assert.equal(h.$('#preview-next').disabled, true);
  assert.equal(h.requests.some(path => path.endsWith('/original')), false);
  h.click('.preview-close'); h.click('#selected-only'); h.click('.photo-image-button');
  h.click('#preview-select');
  assert.equal(h.$('#preview-position').textContent, '不在当前筛选范围');
  assert.equal(h.$('#preview-previous').disabled, true); assert.equal(h.$('#preview-next').disabled, true);
  h.click('.preview-close'); assert.equal(h.$('#preview-image').hasAttribute('src'), false);
});

test('DOM: transfer preflight blocks known over-budget batches before requesting originals', async t => {
  for (const sizes of [[129 * 1024 * 1024], [100 * 1024 * 1024, 100 * 1024 * 1024, 100 * 1024 * 1024]]) {
    const h = await harness(t, { intercept: async url => url.pathname === '/api/photos' ? Response.json({ photos: sizes.map((bytes, i) => ({ id: String(i), name: `R${i}.JPG`, folder: '100RICOH', bytes, thumbnailUrl: '/missing', originalUrl: '/missing/original' })) }) : undefined });
    await h.demo(); h.click('#select-visible');
    assert.equal(h.$('#transfer-plan').classList.contains('blocked'), true);
    h.click('#transfer');
    assert.match(h.$('#notice-text').textContent, /超过/);
    assert.equal(h.requests.some(path => path.endsWith('/original')), false);
    assert.equal(h.all('.queue-item').length, 0);
  }
});

test('DOM: transfer preflight exposes unknown sizes without guessing and excludes duplicates', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input');
  assert.match(h.$('#transfer-plan').textContent, /新传输 1 张/);
  h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  assert.match(h.$('#transfer-plan').textContent, /跳过 1 张已在列表中的照片/);
  assert.doesNotMatch(h.$('#transfer-plan').textContent, /新传输 1 张/);
  const other = await harness(t, { intercept: async url => url.pathname === '/api/photos' ? Response.json({ photos: [{ id: 'unknown', name: 'R1.JPG', folder: '100RICOH', bytes: null, thumbnailUrl: '/missing', originalUrl: '/missing/original' }] }) : undefined });
  await other.demo(); other.click('#select-visible');
  assert.match(other.$('#transfer-plan').textContent, /1 张大小未知/);
  assert.equal(other.$('#transfer-plan').classList.contains('blocked'), false);
});

test('DOM: transfer pace reports measured averages and only estimates known remaining bytes', async t => {
  const h = await harness(t);
  const timingSource = app.slice(app.indexOf('function bytes('), app.indexOf('function dateValue(')) + app.slice(app.indexOf('function durationLabel('), app.indexOf('function itemStatus('));
  const sample = h.window.eval(`${timingSource}\ntransferTiming({ startedAt: 0, finishedAt: 2000, received: 1024, expected: 2048 })`);
  assert.match(sample, /已用 2 秒/); assert.match(sample, /平均 512 B\/秒/); assert.match(sample, /约剩 2 秒/);
  const unknown = h.window.eval(`${timingSource}\ntransferTiming({ startedAt: 0, finishedAt: 2000, received: 1024, expected: null })`);
  assert.doesNotMatch(unknown, /约剩/); assert.match(unknown, /平均/);
  const starting = h.window.eval(`${timingSource}\ntransferTiming({ startedAt: 100, finishedAt: 100, received: 0, expected: 2048 })`);
  assert.equal(starting, '已用 0 秒'); assert.doesNotMatch(starting, /NaN|Infinity/);
});

test('DOM: elapsed progress keeps updating while a read is stalled and cancellation removes it', async t => {
  let started, clock = 0, timerId = 0;
  const timers = new Map();
  const h = await harness(t, { setup: window => {
    Object.defineProperty(window.performance, 'now', { value: () => clock });
    window.setInterval = callback => { timers.set(++timerId, callback); return timerId; };
    window.clearInterval = id => timers.delete(id);
  }, intercept: async (url, opts) => url.pathname.endsWith('/original') ? new Response(new ReadableStream({ start(c) {
    started = true; c.enqueue(original.subarray(0, 20)); opts.signal.addEventListener('abort', () => c.error(new DOMException('cancelled', 'AbortError')));
  } }), { headers: { 'Content-Type': 'image/jpeg' } }) : undefined });
  await h.demo(); h.click('.photo-select input'); h.click('#transfer'); await until(() => started);
  assert.equal(timers.size, 1);
  clock = 2000;
  await until(() => { [...timers.values()].forEach(tick => tick()); return /20 B/.test(h.$('.queue-item-status').textContent); });
  assert.match(h.$('.queue-item-status').textContent, /已用 2 秒/);
  assert.match(h.$('.queue-item-status').textContent, /平均/);
  h.click('#cancel-queue'); await until(() => h.$('.queue-item')?.dataset.state === 'cancelled');
  assert.doesNotMatch(h.$('.queue-item-status').textContent, /已用/);
  assert.equal(timers.size, 0);
});

test('DOM: declining discard keeps ready originals and archive; acceptance releases them', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  const prompts = []; h.window.confirm = message => { prompts.push(message); return false; };
  h.click('#clear-queue'); h.click('.queue-remove');
  assert.equal(h.blobs.size, 2); assert.equal(h.all('.queue-item').length, 1);
  assert.equal(h.$('#save-archive').hidden, false); assert.equal(prompts.length, 2);
  assert.match(prompts[0], /尚未保存/);
  h.window.confirm = () => true; h.click('.queue-remove'); assert.equal(h.blobs.size, 0);
});

test('DOM: unsent originals request unload warning; successful individual or ZIP handoff removes it', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  const warning = new h.window.Event('beforeunload', { cancelable: true }); h.window.dispatchEvent(warning);
  assert.equal(warning.defaultPrevented, true);
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  h.click('#save-archive');
  const after = new h.window.Event('beforeunload', { cancelable: true }); h.window.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false);
  h.window.confirm = () => { throw new Error('Already handed ZIP must not ask again'); };
  h.click('#clear-queue'); assert.equal(h.all('.queue-item').length, 0);
});

test('DOM: standalone verification is two-step, does not request camera or mark the JPEG saved', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready'); const reads = h.requests.length;
  h.click('.verify-original'); await until(() => /保存校验记录/.test(h.$('.verify-original').textContent));
  assert.equal(h.saved.length, 0); assert.equal(h.requests.length, reads);
  h.click('.verify-original'); assert.equal(h.saved.length, 1); assert.match(h.saved[0].filename, /receipt\.json$/);
  const receipt = JSON.parse(await h.saved[0].blob.text()); assert.match(receipt.sha256, /^[0-9a-f]{64}$/);
  assert.equal(h.$('.queue-item').dataset.state, 'ready');
  const leave = new h.window.Event('beforeunload', { cancelable: true }); h.window.dispatchEvent(leave); assert.equal(leave.defaultPrevented, true);
});

test('DOM: cancelling or failing verification preserves the original and permits retry', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  const helpers = h.window.GRTransferFiles;
  h.window.GRTransferFiles = { ...helpers, buildReceipt: (_entry, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) };
  h.click('.verify-original'); assert.equal(h.$('#build-archive').disabled, true); h.click('.verify-original');
  await until(() => /已取消校验/.test(h.$('.file-verification').textContent));
  assert.equal(h.$('.queue-item').dataset.state, 'ready'); assert.equal(h.blobs.size, 1);
  h.window.GRTransferFiles = helpers; h.click('.verify-original');
  await until(() => /保存校验记录/.test(h.$('.verify-original').textContent));
});

test('DOM: thumbnail failures retry only their derivative, preserve selection and stop after three attempts', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input');
  const image = h.$('.photo-image-button img'), source = image.src;
  const originalCount = h.requests.filter(path => path.endsWith('/original')).length;
  image.dispatchEvent(new h.window.Event('error'));
  assert.equal(h.$('.thumbnail-recovery').hidden, false); assert.equal(image.hidden, true);
  h.click('.thumbnail-recovery button'); assert.equal(image.src, source); assert.match(source, /\/thumbnail\?session=/);
  assert.equal(h.$('.thumbnail-recovery button').disabled, true);
  image.dispatchEvent(new h.window.Event('error')); h.click('.thumbnail-recovery button'); image.dispatchEvent(new h.window.Event('error'));
  assert.equal(h.$('.thumbnail-recovery button').disabled, true);
  assert.match(h.$('.thumbnail-recovery').textContent, /检查 Wi-Fi 后刷新/);
  assert.equal(h.$('#selection-count').textContent, '1');
  assert.equal(h.requests.filter(path => path.endsWith('/original')).length, originalCount);
  h.change('#sort', 'name-asc'); h.change('#sort', 'name-desc');
  assert.equal(h.$('.thumbnail-recovery button').disabled, true);
  assert.equal(h.$('.photo-image-button img').hasAttribute('src'), false);
});

test('DOM: successful thumbnail retry restores image and detached stale errors cannot affect a new gallery', async t => {
  const h = await harness(t); await h.demo(); const image = h.$('.photo-image-button img');
  image.dispatchEvent(new h.window.Event('error')); h.click('.thumbnail-recovery button'); image.dispatchEvent(new h.window.Event('load'));
  assert.equal(image.hidden, false); assert.equal(h.$('.thumbnail-recovery').hidden, true);
  h.change('#sort', 'name-asc'); image.dispatchEvent(new h.window.Event('error'));
  assert.equal(h.all('.thumbnail-recovery').every(node => node.hidden), true);
  h.click('#refresh'); await until(() => !h.$('#refresh').disabled);
  assert.equal(h.all('.thumbnail-recovery').every(node => node.hidden), true);
});

test('DOM: RAW-only card gives explicit recovery and refresh updates JPEG+RAW diagnostics', async t => {
  let files = ['R1.DNG'];
  const adapter = new CameraAdapter({ fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/props')
    ? { model: 'RICOH GR III' } : { dirs: [{ name: '100RICOH', files }] }), { headers: { 'content-type': 'application/json' } }) });
  const h = await harness(t, { adapter });
  h.click('#landing-connect'); h.click('#confirm-connect');
  await until(() => !h.$('#workspace').hidden && !h.$('#refresh').disabled);
  assert.equal(h.$('#card-formats').hidden, false);
  assert.match(h.$('#card-formats').textContent, /0 张 JPEG 原片 · 已排除 1 个 RAW/);
  assert.match(h.$('#empty-description').textContent, /只有 RAW，没有 JPEG/);
  assert.match(h.$('#empty-description').textContent, /读卡器/);
  files = ['R1.JPG', 'R1.DNG', 'R1.JPG'];
  h.click('#refresh'); await until(() => h.all('.photo-card').length === 1 && !h.$('#refresh').disabled);
  assert.match(h.$('#card-formats').textContent, /1 张 JPEG 原片 · 已排除 1 个 RAW/);
  assert.match(h.$('#card-formats').textContent, /1 条重复记录/);
  h.click('#disconnect'); await until(() => !h.$('#landing').hidden && !h.$('#try-demo').disabled);
  await h.demo();
  assert.equal(h.$('#card-formats').hidden, true);
  assert.equal(h.$('#card-formats').textContent, '');
});

test('DOM: failed listing explains that camera identity responded without claiming successful transfer', async t => {
  const adapter = new CameraAdapter({ fetchImpl: async url => {
    if (url.endsWith('/props')) return new Response(JSON.stringify({ model: 'RICOH GR III' }));
    throw new TypeError('synthetic listing interruption');
  } });
  const h = await harness(t, { adapter });
  h.click('#landing-connect'); h.click('#confirm-connect');
  await until(() => !h.$('#connect-recovery').hidden);
  assert.match(h.$('#connect-recovery').textContent, /已确认 GR III 型号/);
  assert.match(h.$('#connect-recovery').textContent, /照片列表未读取完成/);
  assert.match(h.$('#connect-recovery').textContent, /尚未请求原片/);
  assert.equal(h.$('#workspace').hidden, true);
});

test('DOM: Chinese onboarding has two clear actions and keeps advanced filters and diagnostics collapsed', async t => {
  const h = await harness(t);
  assert.equal(h.window.document.documentElement.lang, 'zh-CN');
  assert.match(h.$('#landing-heading').textContent, /把喜欢的照片带回来/);
  assert.equal(h.$('#landing-connect').textContent.trim(), '连接相机');
  assert.equal(h.$('#try-demo').textContent, '先试试看');
  assert.match(h.$('.build-note').textContent, /尚未通过真实相机验证/);
  await h.demo();
  assert.equal(h.$('.filter-options').open, false);
  assert.equal(h.$('.card-diagnostics').open, false);
  assert.equal(h.$('#transfer-plan').textContent, '');
  h.$('.filter-options').open = true;
  h.change('#folder', '100RICOH');
  assert.equal(h.all('.photo-card').length, 6);
  assert.equal(h.$('#card-formats').hidden, true); // demo has no camera-returned inventory
  assert.match(h.$('.card-diagnostics').textContent, /不转换 RAW/);
  assert.match(h.$('.photo-select input').getAttribute('aria-label'), /^选择 R/);
});

test('DOM: original verification stays secondary and can be reopened after a completed hash', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  assert.equal(h.$('.file-verification').tagName, 'DETAILS');
  assert.equal(h.$('.file-verification').open, false);
  h.$('.file-verification').open = true; h.click('.verify-original');
  await until(() => h.$('.verify-original').textContent === '保存校验记录');
  assert.equal(h.$('.file-verification').open, true);
  assert.match(h.$('.file-verification .save-note').textContent, /SHA-256: [0-9a-f]{64}/);
  assert.equal(h.saved.length, 0);
});

test('DOM: camera failure codes and unexpected transport errors never leak raw English messages', async t => {
  const h = await harness(t, { adapter: { connect: async () => { throw new AppError('private unlocalized failure details', 'CAMERA_TIMEOUT', 504); } } });
  h.click('#landing-connect'); h.click('#confirm-connect');
  await until(() => !h.$('#connect-error').hidden);
  assert.match(h.$('#connect-error').textContent, /相机响应超时/);
  assert.doesNotMatch(h.$('#connect-error').textContent, /private|unlocalized/);
  const errorSource = app.slice(app.indexOf('function cameraErrorMessage('), app.indexOf('async function api('));
  assert.equal(h.window.eval(`${errorSource}\nuserError(new Error("Failed to fetch"))`), '操作未完成，请检查连接或浏览器支持后重试。');
  assert.match(h.window.eval(`${errorSource}\ncameraErrorMessage("INCOMPLETE_JPEG")`), /文件不完整/);
  assert.match(h.window.eval(`${errorSource}\ncameraErrorMessage("INVALID_CSRF")`), /先保存原片/);
});


test('DOM: invert page respects folder filters and leaves off-page selections intact', async t => {
  const h = await harness(t); await h.demo();
  h.change('#folder', '100RICOH'); h.click('#select-visible');
  h.change('#folder', '101RICOH'); h.click('.photo-select input');
  h.click('#invert-visible'); assert.equal(h.$('#selection-count').textContent, '11');
  h.click('#invert-visible'); assert.equal(h.$('#selection-count').textContent, '7');
  h.$('#selected-only').checked = true; h.$('#selected-only').dispatchEvent(new h.window.Event('change'));
  h.click('#invert-visible'); assert.equal(h.$('#selection-count').textContent, '6');
  assert.equal(h.all('.photo-card').length, 0);
});


test('DOM: next batch skips queued originals, follows filters, and requires explicit transfer', async t => {
  const h = await harness(t); await h.demo(); h.change('#folder', '100RICOH');
  h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  h.click('#select-batch'); assert.equal(h.$('#selection-count').textContent, '5');
  assert.equal(h.all('.queue-item').length, 1);
  h.click('#transfer'); await until(() => h.all('.queue-item[data-state="ready"]').length === 6);
  h.click('#select-batch'); assert.equal(h.$('#selection-count').textContent, '0');
});

test('DOM: next batch conservatively reserves unknown sizes and never exceeds queue capacity', async t => {
  const adapter = { connect: async () => ({ properties: { model: 'RICOH GR III' }, photos: Array.from({length: 60}, (_,i) => ({id: i.toString(16).padStart(24,'0'), folder:'100RICOH', name:`R${i}.JPG`, bytes:null})) }) };
  const h = await harness(t, {adapter}); h.click('#landing-connect'); h.click('#confirm-connect');
  await until(() => h.all('.photo-card').length === 24 && !h.$('#select-batch').disabled);
  h.click('#select-batch'); assert.equal(h.$('#selection-count').textContent, '2');
  assert.equal(h.all('.queue-item').length, 0);
});


test('DOM: hide queued photos updates after transfer and removal without dropping selected IDs', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input');
  h.$('#unqueued-only').checked = true; h.$('#unqueued-only').dispatchEvent(new h.window.Event('change'));
  h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  assert.equal(h.all('.photo-card').length, 11); assert.equal(h.$('#selection-count').textContent, '1');
  h.click('.queue-remove'); assert.equal(h.all('.photo-card').length, 12);
  h.click('#reset-filters'); assert.equal(h.$('#unqueued-only').checked, false);
});
