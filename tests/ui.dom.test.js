// DOM interaction coverage, NOT browser rendering or real disk-download evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { Window } from 'happy-dom';
import { createBridge } from '../src/server.js';
import { AppError } from '../src/camera.js';

const html = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8')).replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../fixtures/manifest.json', import.meta.url)));
const original = await readFile(new URL(`../fixtures/${manifest[0].id}.jpg`, import.meta.url));
async function until(predicate, message = 'UI state did not settle') {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > 2000) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function harness(t, { intercept } = {}) {
  let cameraCalls = 0;
  const server = await createBridge({ adapter: { connect: async () => { cameraCalls++; throw new AppError('Synthetic offline camera. Join camera Wi-Fi and retry.', 'CAMERA_UNREACHABLE', 503); } } });
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
  h.click('.queue-item-top button'); assert.equal(h.saved.length, 1); assert.equal(h.saved[0].filename, 'R0000001.JPG');
  assert.match(h.$('.queue-item-status').textContent, /Sent to browser/);
  h.click('.queue-remove'); assert.equal(h.blobs.size, 0); assert.equal(h.revoked.length, 1);
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
  assert.equal(h.$('#disconnect').disabled, true); h.click('#cancel-queue');
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

test('DOM: disconnect and pagehide release retained files; help states phone networking limit', async t => {
  const h = await harness(t); await h.demo(); h.click('.photo-select input'); h.click('#transfer');
  await until(() => h.$('.queue-item')?.dataset.state === 'ready'); h.click('#disconnect'); await until(() => !h.$('#landing').hidden);
  assert.equal(h.blobs.size, 0); assert.equal(h.$('#workspace').hidden, true);
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
