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
async function harness(t, { intercept, adapter } = {}) {
  let cameraCalls = 0;
  const server = await createBridge({ adapter: adapter || { connect: async () => { cameraCalls++; throw new AppError('Synthetic offline camera. Join camera Wi-Fi and retry.', 'CAMERA_UNREACHABLE', 503); } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const window = new Window({ url: base });
  window.document.write(html);
  // happy-dom lacks the browser's Option constructor. Supply its DOM-equivalent.
  window.Option = function(text, value) { const node = window.document.createElement('option'); node.textContent = text; node.value = value; return node; };
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
  assert.match(h.$('#connection-badge').textContent, /Disconnected/);
  assert.equal(h.cameraCalls(), 0); assert.deepEqual(h.requests, ['/api/session']);
});

test('DOM: demo gallery, folder/search filters, sorting, empty/reset and selection work', async t => {
  const h = await harness(t); await h.demo();
  assert.equal(h.all('.photo-card').length, 12, h.$('#notice-text').textContent); assert.equal(h.$('#demo-banner').hidden, false);
  assert.match(h.$('#connection-badge').textContent, /Synthetic demo/);
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
  assert.match(h.$('.queue-item-status').textContent, /Sent to browser/);
  h.click('.queue-remove'); assert.equal(h.blobs.size, 1); assert.equal(h.revoked.length, 1); // separate download lease remains briefly valid
});

test('DOM: sequential selected downloads, repeat-click deduplication and clear release all Blobs', async t => {
  const h = await harness(t); await h.demo(); h.change('#folder', '100RICOH');
  h.click('#select-visible'); h.click('#transfer');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 6);
  assert.equal(h.blobs.size, 6); h.click('#transfer'); assert.equal(h.all('.queue-item').length, 6);
  assert.match(h.$('#notice-text').textContent, /already in the transfer tray/);
  h.click('#clear-queue'); assert.equal(h.blobs.size, 0); assert.equal(h.$('#queue-panel').hidden, true);
});

test('DOM: failed download is retryable and does not produce a saveable Blob', async t => {
  let attempts = 0;
  const h = await harness(t, { intercept: async url => {
    if (url.pathname.endsWith('/original') && ++attempts === 1) return new Response(JSON.stringify({ error: 'Synthetic interruption' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }});
  await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'failed');
  assert.equal(h.blobs.size, 0); assert.match(h.$('.queue-item-status').textContent, /Synthetic interruption/);
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
  assert.match(h.$('.queue-item-status').textContent, /Retry limit reached/);
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
    assert.equal(h.blobs.size, 0); assert.equal(h.$('.queue-item-top button')?.textContent, 'Retry');
  }
});

test('DOM: failed real-camera connection reconciles demo session and exposes honest error', async t => {
  const h = await harness(t); await h.demo(); h.click('#switch-camera'); h.click('#confirm-connect');
  await until(() => !h.$('#connect-error').hidden);
  assert.equal(h.cameraCalls(), 1); assert.equal(h.$('#landing').hidden, false); assert.equal(h.$('#workspace').hidden, true);
  assert.match(h.$('#connect-error').textContent, /Synthetic offline/); assert.match(h.$('#connection-badge').textContent, /Disconnected/);
  h.click('#connect-dialog .close-dialog'); h.click('#try-demo'); await until(() => !h.$('#workspace').hidden);
});

test('DOM: large list paginates 24 frames, keeps cross-page selections and displays untrusted text safely', async t => {
  const h = await harness(t, { intercept: async url => {
    if (url.pathname === '/api/photos') return Response.json({ mode: 'demo', photos: Array.from({ length: 50 }, (_, i) => ({ id: i.toString(16).padStart(24, '0'), name: i ? `R${String(i).padStart(7, '0')}.JPG` : '<img src=x onerror=alert(1)>.JPG', folder: '100RICOH', bytes: null, width: null, height: null, takenAt: null, thumbnailUrl: '/missing', originalUrl: '/missing', synthetic: true })) });
  }});
  await h.demo(); assert.equal(h.all('.photo-card').length, 24); h.click('#select-visible');
  h.click('#pagination button:last-child'); assert.equal(h.all('.photo-card').length, 24); h.click('#select-visible'); assert.equal(h.$('#selection-count').textContent, '48');
  h.click('#pagination button:last-child'); assert.equal(h.all('.photo-card').length, 2); h.click('#select-visible'); h.click('#transfer');
  assert.match(h.$('#notice-text').textContent, /holds 48/); assert.equal(h.blobs.size, 0);
  h.change('#search', '<img', 'input'); assert.equal(h.all('.photo-card').length, 1); assert.equal(h.$('.photo-meta img'), null);
  assert.equal(h.$('.photo-meta h3').textContent, '<img src=x onerror=alert(1)>.JPG');
});

test('DOM: disconnect preserves completed originals; help states phone networking limit', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready'); h.click('#disconnect'); await until(() => !h.$('#landing').hidden);
  assert.equal(h.blobs.size, 1); assert.equal(h.$('#workspace').hidden, true);
  assert.equal(h.$('#offline-transfers').hidden, false);
  h.click('.queue-item-top button'); assert.equal(h.saved.length, 1);
  h.click('[data-help="phone"]'); assert.match(h.$('#help-content').textContent, /will not reach this computer/);
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
  assert.equal(h.$('#preview-size').textContent, 'Size unknown'); assert.equal(h.$('#preview-dimensions').textContent, 'Not supplied'); assert.equal(h.$('#preview-date').textContent, 'Not supplied');
  assert.equal(h.$('#preview-synthetic').hidden, true);
});

test('DOM: Back/Forward restoration clears unusable Blob URLs and reconciles gallery', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  assert.equal(h.blobs.size, 0); assert.equal(h.all('.queue-item').length, 0);
  const event = new h.window.Event('pageshow'); Object.defineProperty(event, 'persisted', { value: true }); h.window.dispatchEvent(event);
  await until(() => h.all('.photo-card').length === 12 && !h.$('#disconnect').disabled);
  assert.equal(h.all('.queue-item').length, 0); assert.match(h.$('#notice-text').textContent, /cleared|retransfer|transfer.*again/i);
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
  assert.equal(h.all('.queue-item button[aria-label^="Retry"]').length, 0);
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
  assert.equal(h.$('.queue-item-top button'), null); assert.match(h.$('.queue-item-status').textContent, /Reconnect and reselect/);
});

test('DOM: ZIP creation, explicit save handoff, offline save and clear release archive plus originals', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer'); await until(() => h.$('.queue-item')?.dataset.state === 'ready');
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  assert.equal(h.blobs.size, 2); assert.match(h.$('#archive-status').textContent, /SHA-256 manifest/);
  h.click('#disconnect'); await until(() => !h.$('#landing').hidden && !h.$('#disconnect').disabled);
  h.click('#save-archive'); assert.equal(h.saved.length, 1); assert.match(h.saved[0].filename, /^gr3-originals-.*\.zip$/);
  assert.equal(h.saved[0].blob.type, 'application/zip'); assert.match(h.$('#archive-status').textContent, /saving to disk is not verified/);
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
  assert.equal(h.blobs.size, 1); assert.match(h.$('#archive-status').textContent, /cancelled.*still available/);
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
  assert.match(h.$('#archive-status').textContent, /5 original JPEGs/);
  h.click('.queue-item[data-state="failed"] .queue-item-top button');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 6);
  assert.equal(h.$('#save-archive').hidden, true, 'The old partial ZIP must not remain saveable after a new successful retry');
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  assert.match(h.$('#archive-status').textContent, /6 original JPEGs/);
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
  assert.match(h.$('#archive-status').textContent, /24 JPEGs/);
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
  h.click('#build-archive'); await until(() => /Synthetic archive URL failure/.test(h.$('#archive-status').textContent));
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
  assert.match(h.$('#queue-summary').textContent, /1 ready to save.*11 cancelled/);
  assert.equal(h.$('#retry-unfinished').textContent, 'Retry unfinished (11)');
  assert.match(h.$('#recovery-note').textContent, /failed and cancelled.*from the beginning.*Ready JPEGs are kept/);
  const button = h.$('#retry-unfinished'); button.click();
  // Dispatch bypasses native disabled-button click suppression to test the running guard too.
  button.dispatchEvent(new h.window.Event('click'));
  await until(() => h.all('.queue-item[data-state="ready"]').length === 12 && !h.$('#build-archive').disabled);
  assert.equal(reads.size, 12); assert.equal([...reads.values()].reduce((sum, n) => sum + n, 0), 13);
  assert.equal(reads.get(interruptedUrl), 2);
  assert.ok([...h.blobs.values()].includes(readyBlob), 'Completed JPEG Blob is retained, not downloaded again');
  assert.equal(h.$('#queue-recovery').hidden, true); assert.equal(h.$('#retry-unfinished').disabled, true);
  assert.equal(h.$('#queue-summary').textContent, '12 ready to save');
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
  const oldRetry = h.$('#queue-1 button[aria-label^="Retry"]');
  h.click('#disconnect'); await until(() => !h.$('#landing').hidden && !h.$('#disconnect').disabled);
  assert.equal(h.$('#retry-unfinished').hidden, true); assert.equal(h.$('#retry-unfinished').disabled, true);
  phase = 'current'; await h.demo(); h.change('#folder', '100RICOH'); h.click('#select-visible'); h.click('#transfer');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 3 && !h.$('#build-archive').disabled);
  const exhaustedRetry = h.$('#queue-2 button[aria-label^="Retry"]');
  for (let attempt = 2; attempt <= 3; attempt++) {
    h.click('#queue-2 button[aria-label^="Retry"]');
    await until(() => h.$('#queue-2').dataset.state === 'failed' && !h.$('#build-archive').disabled);
  }
  assert.equal(h.$('#retry-unfinished').textContent, 'Retry unfinished (1)');
  assert.match(h.$('#recovery-note').textContent, /1 from a disconnected or changed source/);
  assert.match(h.$('#recovery-note').textContent, /1 no longer available through this connection/);
  assert.match(h.$('#recovery-note').textContent, /1 reached the 3-attempt limit/);
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
  assert.match(h.$('#queue-summary').textContent, /3 ready to save.*1 handed to browser.*2 failed/);
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  const oldZip = [...h.blobs.entries()].find(([, blob]) => blob.type === 'application/zip')[0];
  assert.match(h.$('#archive-status').textContent, /4 original JPEGs/);
  h.click('#retry-unfinished'); assert.equal(h.$('#save-archive').hidden, true); assert.ok(h.revoked.includes(oldZip));
  await until(() => h.all('.queue-item[data-state="ready"]').length === 5 && !h.$('#build-archive').disabled);
  assert.equal(reads, 8); assert.equal(h.all('.queue-item[data-state="handed-off"]').length, 1);
  assert.ok([...h.blobs.values()].includes(saved));
  h.click('#build-archive'); await until(() => !h.$('#save-archive').hidden);
  assert.match(h.$('#archive-status').textContent, /6 original JPEGs/);
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
  assert.equal(h.$('#retry-unfinished').textContent, 'Retry unfinished (11)');
  assert.equal(h.$('#queue-1 button[aria-label^="Retry"]'), null);
  assert.match(h.$('#queue-1 .queue-item-status').textContent, /Retry limit reached/);
  assert.match(h.$('#recovery-note').textContent, /1 reached the 3-attempt limit/);
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
  assert.match(h.$('#connection-badge').textContent, /Camera.*unverified/);
  h.click('#select-visible'); h.click('#transfer');
  await until(() => h.all('.queue-item[data-state="ready"]').length === 2 && !h.$('#retry-unfinished').disabled);
  assert.match(h.$('#recovery-note').textContent, /Restore camera Wi-Fi first/);
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
  assert.ok(h.$('.queue-item-top button[aria-label^="Save"]'));
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
  assert.match(h.$('#connect-recovery').textContent, /Only a device identifying as RICOH GR III/);
  assert.equal(h.$('#connect-recovery').hidden, false);
  h.click('#confirm-connect');
  assert.equal(h.$('#connect-recovery').hidden, true);
  await until(() => !h.$('#connect-error').hidden);
  assert.equal(h.cameraCalls(), 0);
});
