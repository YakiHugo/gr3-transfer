import { createHash } from 'node:crypto';

// This is intentionally not configurable from a request or environment variable.
export const CAMERA_ORIGIN = 'http://192.168.0.1';
export const MAX_JPEG_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const JPEG = /^[A-Za-z0-9_-]{1,64}\.jpe?g$/i;

export class AppError extends Error {
  constructor(message, code = 'CAMERA_ERROR', status = 502) {
    super(message); this.code = code; this.status = status;
  }
}

export function photoId(folder, name) {
  return createHash('sha256').update(`${folder}\0${name}`).digest('hex').slice(0, 24);
}

export function parsePhotoList(data) {
  if (!data || !Array.isArray(data.dirs)) throw new AppError('The camera returned an unfamiliar photo list.', 'UNSUPPORTED_RESPONSE');
  const photos = new Map();
  for (const dir of data.dirs) {
    if (!dir || typeof dir.name !== 'string' || !SEGMENT.test(dir.name) || !Array.isArray(dir.files)) {
      throw new AppError('The camera returned an unfamiliar folder.', 'UNSUPPORTED_RESPONSE');
    }
    for (const name of dir.files) {
      if (typeof name !== 'string') throw new AppError('The camera returned an unfamiliar filename.', 'UNSUPPORTED_RESPONSE');
      if (!/\.jpe?g$/i.test(name)) continue; // RAW/video never silently converted to JPEG.
      if (!JPEG.test(name)) throw new AppError('An unsafe camera filename was rejected.', 'INVALID_PHOTO_PATH');
      const id = photoId(dir.name, name);
      photos.set(id, { id, folder: dir.name, name, bytes: null, takenAt: null, width: null, height: null, synthetic: false });
      if (photos.size > 50000) throw new AppError('This card has more than 50,000 JPEGs. This prototype cannot list it safely.', 'LIST_TOO_LARGE');
    }
  }
  return [...photos.values()].sort((a, b) => b.folder.localeCompare(a.folder) || b.name.localeCompare(a.name));
}

export function safeCameraProperties(data) {
  if (typeof data.model !== 'string' || data.model.trim().replace(/\s+/g, ' ').toUpperCase() !== 'RICOH GR III') {
    throw new AppError('This prototype is for the RICOH GR III. The connected device did not identify as that model.', 'WRONG_MODEL', 409);
  }
  // /props can include a Wi-Fi password, serial number, MAC address and GPS. Never forward them.
  return {
    model: 'RICOH GR III',
    firmware: typeof data.firmwareVersion === 'string' ? data.firmwareVersion.slice(0, 32) : null,
    battery: Number.isFinite(data.battery) && data.battery >= 0 && data.battery <= 100 ? data.battery : null,
  };
}

/** One in-flight camera read. Cancellation removes queued work before it contacts the camera. */
export class ReadQueue {
  #tail = Promise.resolve();
  async run(fn, signal) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { signal?.throwIfAborted(); return await fn(); }
    finally { release(); }
  }
}

export class CameraAdapter {
  constructor({ fetchImpl = globalThis.fetch, jsonTimeout = 12000, streamTimeout = 120000 } = {}) {
    this.fetch = fetchImpl;
    this.jsonTimeout = jsonTimeout;
    this.streamTimeout = streamTimeout;
    this.queue = new ReadQueue();
  }

  async request(path, signal, timeout) {
    if (!/^\/(?:props|photos(?:\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\.jpe?g(?:\?size=(?:thumb|view))?)?)$/i.test(path)) {
      throw new AppError('This camera endpoint is not allowed.', 'ENDPOINT_NOT_ALLOWED', 400);
    }
    try {
      const response = await this.fetch(`${CAMERA_ORIGIN}/v1${path}`, {
        method: 'GET', redirect: 'error',
        headers: { Accept: 'application/json, image/jpeg, application/octet-stream', 'Accept-Encoding': 'identity' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean)),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(`The camera returned HTTP ${response.status}. Keep it awake and retry.`, 'CAMERA_HTTP_ERROR');
      }
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') {
        await response.body?.cancel();
        throw new AppError('The camera returned encoded bytes. Transfer stopped to protect the original file.', 'ENCODED_RESPONSE');
      }
      return response;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (signal?.aborted) throw new AppError('This operation was cancelled.', 'CANCELLED', 409);
      throw new AppError('Could not reach the GR III. Join its Wi-Fi network, keep the camera awake, close other camera apps, then retry.', 'CAMERA_UNREACHABLE', 503);
    }
  }

  async json(path, signal) {
    return this.queue.run(async () => {
      const response = await this.request(path, signal, this.jsonTimeout);
      let size = 0;
      const chunks = [];
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_JSON_BYTES) throw new AppError('The camera response is too large for this prototype.', 'LIST_TOO_LARGE');
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid object');
        if ('errCode' in data && data.errCode !== 200) throw new AppError('The camera reported an error. Keep it awake and retry.', 'CAMERA_REPORTED_ERROR');
        return data;
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (signal?.aborted) throw new AppError('This operation was cancelled.', 'CANCELLED', 409);
        throw new AppError('The camera response was incomplete or unfamiliar. Retry the connection.', 'INVALID_CAMERA_RESPONSE');
      }
    }, signal);
  }

  async connect(signal) {
    const properties = safeCameraProperties(await this.json('/props', signal));
    const photos = parsePhotoList(await this.json('/photos', signal));
    return { properties, photos };
  }

  async list(signal) { return parsePhotoList(await this.json('/photos', signal)); }

  async readPhoto(photo, variant, signal, consume) {
    if (!SEGMENT.test(photo.folder) || !JPEG.test(photo.name)) throw new AppError('Invalid photo path.', 'INVALID_PHOTO_PATH', 400);
    if (!['original', 'thumbnail', 'preview'].includes(variant)) throw new AppError('Invalid image variant.', 'INVALID_VARIANT', 400);
    // Critically: no size parameter for original. ?size=thumb is for gallery previews only.
    const path = `/photos/${encodeURIComponent(photo.folder)}/${encodeURIComponent(photo.name)}${variant === 'thumbnail' ? '?size=thumb' : variant === 'preview' ? '?size=view' : ''}`;
    return this.queue.run(async () => {
      const response = await this.request(path, signal, this.streamTimeout);
      return consume(response);
    }, signal);
  }
}
