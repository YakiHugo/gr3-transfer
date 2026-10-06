import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { CameraAdapter, parsePhotoList, safeCameraProperties, photoId, ReadQueue } from '../src/camera.js';
import { createBridge } from '../src/server.js';

const manifest = JSON.parse(await readFile(new URL('../fixtures/manifest.json', import.meta.url)));
const first = manifest[0];
const original = await readFile(new URL(`../fixtures/${first.id}.jpg`, import.meta.url));
const thumbnail = await readFile(new URL(`../fixtures/${first.id}-thumb.jpg`, import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const data = object => new Response(JSON.stringify(object), { headers: { 'content-type': 'application/json' } });

async function bridge(t, adapter) {
  const server = await createBridge(adapter ? { adapter } : {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(`${base}/api/session`)).json();
  const post = (route, payload) => fetch(`${base}/api/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, Origin: base }, body: JSON.stringify(payload),
  });
  return { base, post, session, server };
}

function fakeCamera({ model = 'RICOH GR III', failList = false, transform = x => x } = {}) {
  const calls = [];
  const adapter = new CameraAdapter({ fetchImpl: async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/props')) return data({ errCode: 200, model, firmwareVersion: 'test-only', battery: 75, key: 'DO-NOT-LEAK', gpsInfo: 'PRIVATE', serialNo: 'PRIVATE', macAddress: 'PRIVATE' });
    if (url.endsWith('/photos')) return data(failList ? { errCode: 500, errMsg: 'SECRET' } : { errCode: 200, dirs: [{ name: first.folder, files: [first.name, 'R0000001.DNG', 'R0000002.MOV'] }] });
    const bytes = transform(url.endsWith('?size=thumb') ? thumbnail : original);
    return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length } });
  }});
  return { adapter, calls };
}

test('photo listing accepts published schema and keeps JPEGs only, with deterministic IDs', () => {
  const parsed = parsePhotoList({ errCode: 200, dirs: [{ name: '100RICOH', files: ['R0000001.JPG', 'R0000002.DNG', 'R0000003.MOV', 'R0000001.JPG', 'custom.jpeg'] }] });
  assert.equal(parsed.length, 2);
  assert.ok(parsed.every(p => p.synthetic === false && p.bytes === null && p.takenAt === null));
  assert.equal(parsed.find(p => p.name === 'R0000001.JPG').id, photoId('100RICOH', 'R0000001.JPG'));
});

test('unfamiliar listing shapes and unsafe paths fail closed', () => {
  for (const value of [null, [], {}, { dirs: [null] }, { dirs: [{ name: '../100RICOH', files: [] }] }, { dirs: [{ name: '100RICOH', files: ['../secret.JPG'] }] }, { dirs: [{ name: '100RICOH', files: [{ name: 'R.JPG' }] }] }]) {
    assert.throws(() => parsePhotoList(value));
  }
  assert.deepEqual(parsePhotoList({ dirs: [] }), []);
});

test('model matching accepts only exact normalized GR III and strictly projects sensitive properties', () => {
  assert.deepEqual(safeCameraProperties({ model: ' ricoh  gr III ', firmwareVersion: '1.91', battery: 40, key: 'secret', gpsInfo: 'secret' }), { model: 'RICOH GR III', firmware: '1.91', battery: 40 });
  for (const model of ['RICOH GR IIIx', 'RICOH GR IV', 'GR III', '', 'RICOH GR III HDF', null]) assert.throws(() => safeCameraProperties({ model }));
});

test('starts disconnected and never calls camera until explicitly connected', async t => {
  const fake = fakeCamera(); const { base, session } = await bridge(t, fake.adapter);
  assert.equal(session.mode, 'disconnected'); assert.equal(session.hardwareVerified, false);
  assert.equal((await fetch(`${base}/api/photos`)).status, 409);
  assert.equal(fake.calls.length, 0);
});

test('demo has 12 unmistakably synthetic images and exact original bytes including EXIF', async t => {
  const fake = fakeCamera(); const { base, post } = await bridge(t, fake.adapter);
  const connected = await (await post('connect', { mode: 'demo' })).json();
  assert.equal(connected.mode, 'demo'); assert.equal(connected.hardwareVerified, false);
  const list = await (await fetch(`${base}/api/photos`)).json();
  assert.equal(list.photos.length, 12); assert.ok(list.photos.every(p => p.synthetic));
  const response = await fetch(base + list.photos[0].originalUrl);
  assert.equal(response.headers.get('x-file-size'), String(original.length));
  assert.match(response.headers.get('content-disposition'), /attachment/);
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(downloaded), hash(original));
  assert.ok(downloaded.includes(Buffer.from('SYNTHETIC FIXTURE')));
  assert.equal(fake.calls.length, 0);
});

test('camera connection uses only fixed read-only endpoint allowlist and omits size for originals', async t => {
  const fake = fakeCamera(); const { base, post } = await bridge(t, fake.adapter);
  const connect = await post('connect', { mode: 'camera' }); assert.equal(connect.status, 200);
  const connected = await connect.json();
  assert.equal(connected.model, 'RICOH GR III'); assert.equal(connected.hardwareVerified, false);
  assert.equal(connected.firmware, 'test-only'); assert.equal(connected.battery, 75);
  assert.doesNotMatch(JSON.stringify(connected), /DO-NOT-LEAK|PRIVATE|serialNo|macAddress|gpsInfo/);
  const list = await (await fetch(`${base}/api/photos`)).json();
  assert.equal(list.photos.length, 1);
  const p = list.photos[0];
  assert.equal(hash(Buffer.from(await (await fetch(base + p.thumbnailUrl)).arrayBuffer())), hash(thumbnail));
  assert.equal(hash(Buffer.from(await (await fetch(base + p.originalUrl)).arrayBuffer())), hash(original));
  assert.deepEqual(fake.calls.map(c => c.url), [
    'http://192.168.0.1/v1/props', 'http://192.168.0.1/v1/photos',
    `http://192.168.0.1/v1/photos/${first.folder}/${first.name}?size=thumb`,
    `http://192.168.0.1/v1/photos/${first.folder}/${first.name}`,
  ]);
  assert.ok(fake.calls.every(c => c.opts.method === 'GET' && c.opts.redirect === 'error' && c.opts.headers['Accept-Encoding'] === 'identity'));
});

test('wrong model and camera-level JSON errors do not create connected sessions or leak raw errors', async t => {
  for (const opts of [{ model: 'RICOH GR IIIx' }, { failList: true }]) {
    const { base, post } = await bridge(t, fakeCamera(opts).adapter);
    const response = await post('connect', { mode: 'camera' });
    assert.ok(response.status >= 400);
    assert.doesNotMatch(await response.text(), /SECRET|PRIVATE/);
    assert.equal((await (await fetch(`${base}/api/session`)).json()).connected, false);
  }
});

test('refresh returns latest list and disconnect makes old URLs unusable', async t => {
  const { base, post } = await bridge(t);
  await post('connect', { mode: 'demo' });
  const list = await (await post('refresh', {})).json(); assert.equal(list.photos.length, 12);
  await post('disconnect', {});
  assert.equal((await fetch(base + list.photos[0].originalUrl)).status, 409);
  await post('connect', { mode: 'demo' });
  assert.equal((await fetch(base + list.photos[0].originalUrl)).status, 409);
});

test('same-origin / localhost / CSRF protection blocks third-party requests and rebinding', async t => {
  const { base, post } = await bridge(t);
  for (const headers of [{ Host: 'attacker.example' }, { Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    const status = await new Promise((resolve, reject) => { const req = http.get(`${base}/api/session`, { headers }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  assert.equal((await fetch(`${base}/api/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"demo"}' })).status, 403);
  assert.equal((await post('connect', { mode: 'demo', target: 'http://attacker.example' })).status, 200);
  assert.equal((await fetch(`${base}/src/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/fixtures/manifest.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/photos`, { method: 'DELETE' })).status, 405);
});

test('JPEG payload ending early never completes successfully', async t => {
  const fake = fakeCamera({ transform: x => x.subarray(0, x.length - 20) });
  const { base, post } = await bridge(t, fake.adapter);
  await post('connect', { mode: 'camera' });
  const list = await (await fetch(`${base}/api/photos`)).json();
  await assert.rejects(async () => { const r = await fetch(base + list.photos[0].originalUrl); await r.arrayBuffer(); });
});

test('HTML masquerading as JPEG is rejected before successful body', async t => {
  const fake = fakeCamera({ transform: () => Buffer.from('<html>not a photo</html>') });
  const { base, post } = await bridge(t, fake.adapter);
  await post('connect', { mode: 'camera' });
  const list = await (await fetch(`${base}/api/photos`)).json();
  const result = await fetch(base + list.photos[0].originalUrl);
  assert.equal(result.status, 502); assert.equal((await result.json()).code, 'NOT_JPEG');
});

test('camera request failures produce safe actionable errors', async () => {
  const adapter = new CameraAdapter({ fetchImpl: async () => { throw new Error('internal network secret'); } });
  await assert.rejects(adapter.connect(), e => e.code === 'CAMERA_UNREACHABLE' && !e.message.includes('secret'));
});

test('encoded camera responses cannot silently transform original bytes', async () => {
  const adapter = new CameraAdapter({ fetchImpl: async () => new Response(original, { headers: { 'content-encoding': 'gzip' } }) });
  await assert.rejects(adapter.json('/props'), e => e.code === 'ENCODED_RESPONSE');
});

test('camera read queue serializes and skips cancelled pending requests', async () => {
  const queue = new ReadQueue(); const order = []; let release;
  const block = new Promise(r => { release = r; });
  const first = queue.run(async () => { order.push(1); await block; order.push(2); });
  const controller = new AbortController();
  const cancelled = queue.run(() => { order.push('BAD'); }, controller.signal);
  const rejected = assert.rejects(cancelled);
  const last = queue.run(() => { order.push(3); });
  controller.abort(); release();
  await Promise.all([first, rejected, last]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('new connection wins over an older pending camera handshake', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const adapter = { connect: async () => { await gate; return { properties: { model: 'RICOH GR III' }, photos: [] }; } };
  const { base, post } = await bridge(t, adapter);
  const pending = post('connect', { mode: 'camera' });
  await new Promise(resolve => setTimeout(resolve, 20));
  await post('connect', { mode: 'demo' }); release();
  assert.equal((await pending).status, 409);
  assert.equal((await (await fetch(`${base}/api/session`)).json()).mode, 'demo');
});

 test('camera request classifies timeout separately and keeps cancellation precedence', async () => {
  const adapter = new CameraAdapter({ fetchImpl: async () => { throw new DOMException('Timed out', 'TimeoutError'); } });
  await assert.rejects(adapter.request('/props', undefined, 1), { code: 'CAMERA_TIMEOUT', status: 504 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter.request('/props', controller.signal, 1), { code: 'CANCELLED' });
});

test('abandoning an in-flight connection aborts its camera read without a separate disconnect', async t => {
  let enter, abort;
  const entered = new Promise(resolve => { enter = resolve; });
  const aborted = new Promise(resolve => { abort = resolve; });
  const adapter = { connect: signal => new Promise((resolve, reject) => {
    enter(); signal.addEventListener('abort', () => { abort(); reject(signal.reason); });
  }) };
  const { base, session } = await bridge(t, adapter);
  const controller = new AbortController();
  const request = fetch(`${base}/api/connect`, { method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, Origin: base }, body: JSON.stringify({ mode: 'camera' }) });
  const rejection = assert.rejects(request, { name: 'AbortError' });
  await entered; controller.abort(); await rejection;
  let timer;
  try { await Promise.race([aborted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Camera read not aborted')), 1000); })]); }
  finally { clearTimeout(timer); }
  assert.equal((await (await fetch(`${base}/api/session`)).json()).connected, false);
});

test('card format inventory distinguishes RAW-only, JPEG+RAW pairs and duplicate listings without fetching files', async t => {
  const calls = [];
  let dirs = [{ name: '100RICOH', files: ['R1.JPG', 'R1.DNG', 'R1.JPG', 'R2.PEF', 'movie.MOV'] }, { name: '101RICOH', files: ['R1.JPG'] }];
  const adapter = new CameraAdapter({ fetchImpl: async url => {
    calls.push(url);
    return data(url.endsWith('/props') ? { model: 'RICOH GR III' } : { dirs });
  } });
  const { base, post } = await bridge(t, adapter);
  await post('connect', { mode: 'camera' });
  const result = await (await fetch(`${base}/api/photos`)).json();
  assert.equal(result.photos.length, 2);
  assert.deepEqual(result.summary, { jpeg: 2, raw: 2, other: 1, duplicateEntries: 1 });
  dirs = [{ name: '100RICOH', files: ['R1.DNG'] }];
  const refreshed = await (await post('refresh', {})).json();
  assert.equal(refreshed.photos.length, 0);
  assert.deepEqual(refreshed.summary, { jpeg: 0, raw: 1, other: 0, duplicateEntries: 0 });
  assert.ok(calls.every(url => url.endsWith('/props') || url.endsWith('/photos')));
  await post('connect', { mode: 'demo' });
  assert.equal((await (await fetch(`${base}/api/photos`)).json()).summary, null);
});

test('format diagnostics never expose excluded RAW names or untrusted camera properties', async t => {
  const adapter = new CameraAdapter({ fetchImpl: async url => data(url.endsWith('/props')
    ? { model: 'RICOH GR III', key: 'SECRET_WIFI' }
    : { dirs: [{ name: '100RICOH', files: ['PRIVATE_RAW.DNG', '<script>PRIVATE.MOV'] }] }) });
  const { base, post } = await bridge(t, adapter);
  await post('connect', { mode: 'camera' });
  const text = await (await fetch(`${base}/api/photos`)).text();
  assert.doesNotMatch(text, /PRIVATE|SECRET|script/);
  assert.equal(JSON.parse(text).summary.raw, 1);
});

test('connection diagnostics identify identity versus listing failure without leaking camera data', async t => {
  let failIdentity = true;
  const adapter = new CameraAdapter({ fetchImpl: async url => {
    if (url.endsWith('/props') && !failIdentity) return data({ model: 'RICOH GR III', key: 'PRIVATE' });
    throw new TypeError('PRIVATE_NETWORK_DETAILS');
  } });
  const { post } = await bridge(t, adapter);
  const identity = await (await post('connect', { mode: 'camera' })).json();
  assert.equal(identity.cameraStage, 'identity');
  failIdentity = false;
  const listing = await (await post('connect', { mode: 'camera' })).json();
  assert.equal(listing.cameraStage, 'listing');
  assert.equal(listing.code, 'CAMERA_UNREACHABLE');
  assert.doesNotMatch(JSON.stringify([identity, listing]), /PRIVATE/);
});

test('JSON body timeout remains a timeout rather than an unsupported firmware diagnosis', async () => {
  const adapter = new CameraAdapter({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('private detail', 'TimeoutError')); } })) });
  await assert.rejects(adapter.connect(), error => error.code === 'CAMERA_TIMEOUT' && error.status === 504 && error.cameraStage === 'identity' && !error.message.includes('private'));
});
