/* Original-byte download packaging. No compression, image decoding or metadata rewriting. */
(function (root) {
  'use strict';
  const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
  const encoder = new TextEncoder();
  const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
    let n = i;
    for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    return n >>> 0;
  });
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function crc32Interruptible(bytes, signal) {
    let crc = 0xffffffff;
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      signal?.throwIfAborted();
      const end = Math.min(bytes.length, offset + 1024 * 1024);
      for (let i = offset; i < end; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
      // Yield between bounded chunks so the browser can process Cancel and page lifecycle events.
      if (end < bytes.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
    signal?.throwIfAborted();
    return (crc ^ 0xffffffff) >>> 0;
  }
  function components(photo) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(photo.folder) || !/^[A-Za-z0-9_-]{1,64}\.jpe?g$/i.test(photo.name)) {
      throw new Error('照片文件夹或文件名未通过安全检查。');
    }
    return [photo.folder, photo.name];
  }
  function downloadName(photo) {
    const [folder, name] = components(photo);
    // Length-prefixing makes the flattened name unambiguous even when components contain underscores.
    return `${folder.length}-${folder}__${name}`;
  }
  function dosTime(date) {
    const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
    return { time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1), date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate() };
  }
  function header(length) { const bytes = new Uint8Array(length); return { bytes, view: new DataView(bytes.buffer) }; }
  function putFile(path, blob, crc, stamp, offset) {
    const name = encoder.encode(path);
    const local = header(30 + name.length), central = header(46 + name.length);
    const l = local.view, c = central.view;
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true);
    l.setUint16(10, stamp.time, true); l.setUint16(12, stamp.date, true);
    l.setUint32(14, crc, true); l.setUint32(18, blob.size, true); l.setUint32(22, blob.size, true); l.setUint16(26, name.length, true); local.bytes.set(name, 30);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(12, stamp.time, true); c.setUint16(14, stamp.date, true);
    c.setUint32(16, crc, true); c.setUint32(20, blob.size, true); c.setUint32(24, blob.size, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true); central.bytes.set(name, 46);
    return { parts: [local.bytes, blob], central: central.bytes, size: local.bytes.length + blob.size };
  }
  async function buildReceipt(entry, { signal, createdAt = new Date() } = {}) {
    signal?.throwIfAborted();
    const [folder, name] = components(entry.photo);
    if (!entry.blob || entry.blob.type !== 'image/jpeg' || !entry.blob.size || entry.blob.size > 128 * 1024 * 1024) throw new Error('请先完成 JPEG 原片传输，再进行校验。');
    if (!root.crypto?.subtle) throw new Error('浏览器不支持校验，原片仍可保存。');
    if (!Number.isFinite(createdAt.getTime())) throw new Error('校验记录日期无效。');
    const bytes = await entry.blob.arrayBuffer();
    signal?.throwIfAborted();
    const digest = await root.crypto.subtle.digest('SHA-256', bytes);
    signal?.throwIfAborted();
    const receipt = {
      formatVersion: 1, createdAt: createdAt.toISOString(),
      checksumScope: 'Retained browser JPEG bytes; not an independent camera checksum or proof of saving to disk.',
      transformation: 'none', cameraFolder: folder, cameraFilename: name,
      downloadFilename: downloadName(entry.photo), bytes: entry.blob.size,
      sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
      source: { mode: entry.sourceMode === 'camera' ? 'camera' : 'demo', hardwareVerified: false },
    };
    return { receipt, blob: new Blob([`${JSON.stringify(receipt, null, 2)}\n`], { type: 'application/json' }), filename: `${downloadName(entry.photo)}.receipt.json` };
  }
  async function buildBatchReceipt(entries, { signal, createdAt = new Date(), onProgress = () => {} } = {}) {
    signal?.throwIfAborted();
    if (!entries.length || entries.length > 48) throw new Error('每份批次校验清单需要 1 到 48 张已完成的原片。');
    if (entries.reduce((sum, entry) => sum + (entry.blob?.size || 0), 0) > MAX_ARCHIVE_BYTES) throw new Error('批次超过 256 MiB 暂存上限。');
    const sources = [...new Set(entries.map(entry => entry.sourceId))];
    if (sources.some(source => typeof source !== 'string' || !source)) throw new Error('缺少传输来源标识，请重新传输。');
    const paths = new Set(), files = [];
    for (const [index, entry] of entries.entries()) {
      signal?.throwIfAborted();
      const sourceIndex = sources.indexOf(entry.sourceId) + 1;
      const path = `${sourceIndex}/${components(entry.photo).join('/')}`.toLowerCase();
      if (paths.has(path)) throw new Error('同一来源包含重复的照片路径。');
      paths.add(path);
      const result = await buildReceipt(entry, { signal, createdAt });
      files.push({ ...result.receipt, source: { ...result.receipt.source, index: sourceIndex } });
      onProgress(index + 1, entries.length);
    }
    signal?.throwIfAborted();
    const receipt = { formatVersion: 1, createdAt: createdAt.toISOString(), photosIncluded: false, files };
    return { receipt, blob: new Blob([`${JSON.stringify(receipt, null, 2)}\n`], { type: 'application/json' }), filename: `gr3-verification-${createdAt.toISOString().replace(/[-:]/g, '').slice(0, 15)}.json` };
  }
  async function buildArchive(entries, { signal, createdAt = new Date(), onProgress = () => {} } = {}) {
    signal?.throwIfAborted();
    if (!entries.length) throw new Error('请先传输至少一张 JPEG，再进行打包。');
    if (entries.length > 48) throw new Error('每个压缩包最多包含 48 张原片。');
    if (!root.crypto?.subtle) throw new Error('浏览器不支持校验，可逐张保存原片，或使用较新的桌面浏览器。');
    if (!Number.isFinite(createdAt.getTime())) throw new Error('压缩包日期无效。');
    const total = entries.reduce((n, entry) => n + (entry.blob?.size || 0), 0);
    if (total > MAX_ARCHIVE_BYTES) throw new Error('压缩包超过 256 MiB 暂存上限。');
    const sources = [...new Set(entries.map(entry => entry.sourceId))];
    if (sources.some(id => typeof id !== 'string' || !id)) throw new Error('缺少传输来源标识，请重新传输。');
    const stamp = dosTime(createdAt), parts = [], central = [], files = [], paths = new Set();
    let offset = 0;
    for (const [index, entry] of entries.entries()) {
      signal?.throwIfAborted();
      const [folder, name] = components(entry.photo);
      if (!entry.blob || entry.blob.type !== 'image/jpeg' || !entry.blob.size || entry.blob.size > 128 * 1024 * 1024) throw new Error('暂存的 JPEG 已失效或超过大小限制。');
      const sourceIndex = sources.indexOf(entry.sourceId) + 1;
      const path = `${sources.length > 1 ? `source-${String(sourceIndex).padStart(2, '0')}/` : ''}${folder}/${name}`;
      if (paths.has(path.toLowerCase())) throw new Error('两张照片使用了相同的压缩包路径，请先移除其中一项。');
      paths.add(path.toLowerCase());
      const bytes = new Uint8Array(await entry.blob.arrayBuffer());
      signal?.throwIfAborted();
      const digest = await root.crypto.subtle.digest('SHA-256', bytes);
      signal?.throwIfAborted();
      const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const crc = await crc32Interruptible(bytes, signal);
      const packed = putFile(path, entry.blob, crc, stamp, offset);
      parts.push(...packed.parts); central.push(packed.central); offset += packed.size;
      files.push({ path, cameraFolder: folder, cameraFilename: name, bytes: entry.blob.size, sha256, source: { index: sourceIndex, mode: entry.sourceMode === 'camera' ? 'camera' : 'demo', hardwareVerified: false } });
      onProgress(index + 1, entries.length);
    }
    const manifest = { formatVersion: 1, createdAt: createdAt.toISOString(), checksumScope: 'Retained browser JPEG bytes; not an independent camera checksum or proof of saving to disk.', transformation: 'none', files };
    const manifestBytes = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
    const manifestBlob = new Blob([manifestBytes], { type: 'application/json' });
    const packedManifest = putFile('transfer-manifest.json', manifestBlob, crc32(manifestBytes), stamp, offset);
    parts.push(...packedManifest.parts); central.push(packedManifest.central); offset += packedManifest.size;
    const centralBytes = central.reduce((sum, data) => sum + data.length, 0), count = central.length;
    const end = header(22); end.view.setUint32(0, 0x06054b50, true); end.view.setUint16(8, count, true); end.view.setUint16(10, count, true); end.view.setUint32(12, centralBytes, true); end.view.setUint32(16, offset, true);
    signal?.throwIfAborted();
    return { blob: new Blob([...parts, ...central, end.bytes], { type: 'application/zip' }), filename: `gr3-originals-${createdAt.toISOString().replace(/[-:]/g, '').slice(0, 15)}.zip`, manifest };
  }
  root.GRTransferFiles = Object.freeze({ downloadName, buildArchive, buildReceipt, buildBatchReceipt, crc32 });
})(globalThis);
