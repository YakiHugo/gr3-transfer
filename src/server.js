import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
import { CameraAdapter, AppError, MAX_JPEG_BYTES } from './camera.js';
import { JpegValidator } from './jpeg.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/transfer-files.js', ['transfer-files.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

function json(res, status, data) {
  const bytes = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length });
  res.end(bytes);
}

async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new AppError('Use a JSON request.', 'BAD_REQUEST', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024) throw new AppError('Request too large.', 'BAD_REQUEST', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new AppError('Invalid JSON request.', 'BAD_REQUEST', 400); }
}

function safeToken(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Stream untouched bytes with backpressure; incomplete/error responses never become a successful download. */
export async function pipeJpeg(response, res, { name, original, signal }) {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType && !['image/jpeg', 'application/octet-stream', 'binary/octet-stream'].includes(contentType)) {
    await response.body?.cancel();
    throw new AppError('The camera did not return a JPEG. Transfer stopped.', 'NOT_JPEG');
  }
  const lengthHeader = response.headers.get('content-length');
  const length = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  if (length !== null && (length < 4 || length > MAX_JPEG_BYTES)) {
    await response.body?.cancel();
    throw new AppError('This JPEG is outside the supported size limit (128 MiB).', 'INVALID_FILE_SIZE');
  }
  let total = 0, prefix = Buffer.alloc(0), started = false;
  const validator = new JpegValidator();
  try {
    for await (const value of response.body) {
      signal?.throwIfAborted();
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_JPEG_BYTES) throw new AppError('File exceeded the size limit.', 'INVALID_FILE_SIZE');
      let output = chunk;
      if (!started) {
        prefix = Buffer.concat([prefix, chunk]);
        if (prefix.length < 3) continue;
        if (prefix[0] !== 0xff || prefix[1] !== 0xd8 || prefix[2] !== 0xff) throw new AppError('The returned file is not a JPEG.', 'NOT_JPEG');
        const headers = { 'Content-Type': 'image/jpeg', 'Content-Disposition': `${original ? 'attachment' : 'inline'}; filename="${name}"` };
        // Chunked output deliberately withholds HTTP completion until JPEG/length validation.
        // This lets the browser reject truncated payloads even when the upstream claimed a length.
        if (length !== null) headers['X-File-Size'] = String(length);
        res.writeHead(200, headers);
        started = true;
        output = prefix;
      }
      validator.push(output);
      if (!res.write(output)) await once(res, 'drain', { signal });
    }
    if (!started || (length !== null && total !== length)) {
      throw new AppError('The JPEG transfer was incomplete. Retry this file.', 'INCOMPLETE_JPEG');
    }
    validator.finish();
    res.end();
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    throw error;
  }
}

export async function createBridge({ adapter = new CameraAdapter(), fixtureRoot = path.join(ROOT, 'fixtures') } = {}) {
  const fixtures = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
  const csrfToken = randomBytes(24).toString('hex');
  let generation = randomBytes(12).toString('hex');
  let controller = new AbortController();
  let state = { mode: 'disconnected', connected: false, model: 'RICOH GR III', firmware: null, battery: null };
  let photos = [];
  let photoMap = new Map();
  const session = () => ({ ...state, csrfToken, hardwareVerified: false, sessionId: generation, photosCount: photos.length, localOnly: true });
  const reset = () => {
    controller.abort(); controller = new AbortController(); generation = randomBytes(12).toString('hex');
    photos = []; photoMap = new Map();
    state = { mode: 'disconnected', connected: false, model: 'RICOH GR III', firmware: null, battery: null };
  };
  const assign = list => {
    photos = list.map(p => ({ ...p, thumbnailUrl: `/api/photos/${p.id}/thumbnail?session=${generation}`, previewUrl: `/api/photos/${p.id}/preview?session=${generation}`, originalUrl: `/api/photos/${p.id}/original?session=${generation}` }));
    photoMap = new Map(photos.map(p => [p.id, p]));
  };
  const photoList = () => ({ photos, mode: state.mode, hardwareVerified: false });

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      const port = server.address()?.port;
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!hosts.has(req.headers.host)) throw new AppError('This bridge only accepts its local address.', 'INVALID_HOST', 403);
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin) throw new AppError('Cross-origin requests are blocked.', 'INVALID_ORIGIN', 403);
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new AppError('Cross-site requests are blocked.', 'CROSS_SITE', 403);
      const url = new URL(req.url, origin);
      if (!['GET', 'POST'].includes(req.method)) throw new AppError('Method not allowed.', 'METHOD_NOT_ALLOWED', 405);
      if (req.method === 'POST' && !safeToken(req.headers['x-csrf-token'], csrfToken)) throw new AppError('Reload this page before trying again.', 'INVALID_CSRF', 403);
      if (req.method === 'GET' && STATIC.has(url.pathname)) {
        const [filename, type] = STATIC.get(url.pathname);
        const data = await readFile(path.join(ROOT, 'public', filename));
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length }); res.end(data); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/session') { json(res, 200, session()); return; }
      if (req.method === 'POST' && url.pathname === '/api/connect') {
        const input = await body(req);
        if (!['demo', 'camera'].includes(input.mode)) throw new AppError('Choose demo or camera mode.', 'INVALID_MODE', 400);
        reset();
        const signal = controller.signal;
        if (input.mode === 'demo') {
          state = { mode: 'demo', connected: true, model: 'RICOH GR III · demo', firmware: null, battery: null };
          assign(fixtures);
        } else {
          const result = await adapter.connect(signal);
          signal.throwIfAborted();
          state = { mode: 'camera', connected: true, ...result.properties };
          assign(result.photos);
        }
        json(res, 200, session()); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/disconnect') {
        await body(req); reset(); json(res, 200, session()); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        await body(req);
        if (!state.connected) throw new AppError('Connect your camera or open the demo first.', 'DISCONNECTED', 409);
        const signal = controller.signal;
        if (state.mode === 'camera') {
          const list = await adapter.list(signal); signal.throwIfAborted(); assign(list);
        }
        json(res, 200, photoList()); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/photos') {
        if (!state.connected) throw new AppError('Connect your camera or open the demo first.', 'DISCONNECTED', 409);
        json(res, 200, photoList()); return;
      }
      const match = url.pathname.match(/^\/api\/photos\/([a-f0-9]{24})\/(thumbnail|preview|original)$/);
      if (req.method === 'GET' && match) {
        if (!state.connected || url.searchParams.get('session') !== generation) throw new AppError('This gallery session has ended. Reload the gallery.', 'STALE_SESSION', 409);
        const photo = photoMap.get(match[1]);
        if (!photo) throw new AppError('This photo is no longer in the current gallery.', 'PHOTO_NOT_FOUND', 404);
        const requestController = new AbortController();
        res.on('close', () => requestController.abort());
        const signal = AbortSignal.any([controller.signal, requestController.signal]);
        const consume = response => pipeJpeg(response, res, { name: photo.name, original: match[2] === 'original', signal });
        if (state.mode === 'demo') {
          const filename = match[2] === 'thumbnail' ? `${photo.id}-thumb.jpg` : match[2] === 'preview' ? `${photo.id}-preview.jpg` : `${photo.id}.jpg`;
          const bytes = await readFile(path.join(fixtureRoot, filename));
          signal.throwIfAborted();
          await consume(new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'content-length': bytes.length } }));
        } else await adapter.readPhoto(photo, match[2], signal, consume);
        return;
      }
      throw new AppError('Not found.', 'NOT_FOUND', 404);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const expected = error instanceof AppError;
      const cancelled = error?.name === 'AbortError';
      json(res, expected ? error.status : cancelled ? 409 : 500, {
        error: expected ? error.message : cancelled ? 'The previous operation was cancelled.' : 'The local bridge could not finish that request. Retry or restart it.',
        code: expected ? error.code : cancelled ? 'CANCELLED' : 'INTERNAL_ERROR',
      });
    }
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  server.on('close', () => controller.abort());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
  const server = await createBridge();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to another local port.` : 'Could not start the local bridge.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`GR III Transfer · http://127.0.0.1:${port}\nLoopback only · disconnected · no camera requests until Connect GR III`));
}
