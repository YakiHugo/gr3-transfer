import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const code = await readFile(new URL('../public/transfer-files.js', import.meta.url), 'utf8');
const context = { Blob, TextEncoder, Uint8Array, Uint32Array, DataView, Date, setTimeout, crypto: webcrypto };
runInNewContext(code, context);
const { downloadName, buildArchive, crc32 } = context.GRTransferFiles;
const manifest = JSON.parse(await readFile(new URL('../fixtures/manifest.json', import.meta.url)));
const image = await readFile(new URL(`../fixtures/${manifest[0].id}.jpg`, import.meta.url));
const entry = (overrides = {}) => ({ photo: { folder: '100RICOH', name: 'R0000001.JPG' }, sourceId: 'synthetic-session', sourceMode: 'demo', blob: new Blob([image], { type: 'image/jpeg' }), ...overrides });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function unpack(bytes) {
  const files = new Map(); let position = 0;
  while (bytes.readUInt32LE(position) === 0x04034b50) {
    const flags = bytes.readUInt16LE(position + 6), method = bytes.readUInt16LE(position + 8);
    const crc = bytes.readUInt32LE(position + 14), packedSize = bytes.readUInt32LE(position + 18), size = bytes.readUInt32LE(position + 22), nameLength = bytes.readUInt16LE(position + 26), extraLength = bytes.readUInt16LE(position + 28);
    assert.equal(flags, 0x800); assert.equal(method, 0); assert.equal(packedSize, size);
    const path = bytes.subarray(position + 30, position + 30 + nameLength).toString('utf8');
    const start = position + 30 + nameLength + extraLength;
    assert.ok(!files.has(path)); files.set(path, { bytes: bytes.subarray(start, start + size), crc, offset: position });
    position = start + size;
  }
  const directoryStart = position;
  for (const [path, file] of files) {
    assert.equal(bytes.readUInt32LE(position), 0x02014b50);
    assert.equal(bytes.readUInt32LE(position + 16), file.crc);
    assert.equal(bytes.readUInt32LE(position + 24), file.bytes.length);
    assert.equal(bytes.readUInt32LE(position + 42), file.offset);
    const length = bytes.readUInt16LE(position + 28);
    assert.equal(bytes.subarray(position + 46, position + 46 + length).toString(), path);
    position += 46 + length;
  }
  assert.equal(bytes.readUInt32LE(position), 0x06054b50);
  assert.equal(bytes.readUInt16LE(position + 10), files.size);
  assert.equal(bytes.readUInt32LE(position + 12), position - directoryStart);
  assert.equal(bytes.readUInt32LE(position + 16), directoryStart);
  assert.equal(position + 22, bytes.length);
  return files;
}

test('files: individual save names retain folder identity, reject traversal and avoid ambiguous component joins', () => {
  assert.equal(downloadName({ folder: '100RICOH', name: 'R0000001.JPG' }), '8-100RICOH__R0000001.JPG');
  assert.notEqual(downloadName({ folder: '100RICOH', name: 'R.JPG' }), downloadName({ folder: '101RICOH', name: 'R.JPG' }));
  assert.notEqual(downloadName({ folder: 'A__B', name: 'C.JPG' }), downloadName({ folder: 'A', name: 'B__C.JPG' }));
  for (const photo of [{ folder: '../photos', name: 'R.JPG' }, { folder: '100RICOH', name: '../R.JPG' }, { folder: '100RICOH', name: 'R.JPG\r\nX-Evil: true' }]) assert.throws(() => downloadName(photo));
});

test('files: CRC-32 matches the standard empty and 123456789 vectors', () => {
  assert.equal(crc32(new Uint8Array()), 0); assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('files: ZIP stores originals under camera folders and includes byte-accurate SHA-256 manifest', async () => {
  const result = await buildArchive([entry(), entry({ photo: { folder: '101RICOH', name: 'R0000001.JPG' } })], { createdAt: new Date('2026-10-02T06:00:00Z') });
  assert.equal(result.filename, 'gr3-originals-20261002T060000.zip');
  const files = unpack(Buffer.from(await result.blob.arrayBuffer()));
  assert.deepEqual([...files.keys()], ['100RICOH/R0000001.JPG', '101RICOH/R0000001.JPG', 'transfer-manifest.json']);
  for (const path of [...files.keys()].filter(p => p.endsWith('.JPG'))) {
    assert.deepEqual(files.get(path).bytes, image);
    assert.ok(files.get(path).bytes.includes(Buffer.from('SYNTHETIC FIXTURE')));
  }
  const receipt = JSON.parse(files.get('transfer-manifest.json').bytes);
  assert.equal(receipt.files.length, 2); assert.equal(receipt.files[0].sha256, hash(image)); assert.equal(receipt.files[0].bytes, image.length);
  assert.equal(receipt.files[0].source.mode, 'demo'); assert.equal(receipt.files[0].source.hardwareVerified, false);
  assert.match(receipt.checksumScope, /not.*proof.*disk/);
});

test('files: separate source sessions cannot overwrite identical camera paths within an archive', async () => {
  const result = await buildArchive([entry(), entry({ sourceId: 'another-session', sourceMode: 'camera' })]);
  const files = unpack(Buffer.from(await result.blob.arrayBuffer()));
  assert.ok(files.has('source-01/100RICOH/R0000001.JPG')); assert.ok(files.has('source-02/100RICOH/R0000001.JPG'));
});

test('files: exact and case-insensitive duplicate archive paths are rejected', async () => {
  await assert.rejects(buildArchive([entry(), entry()]), /same archive path/);
  await assert.rejects(buildArchive([entry(), entry({ photo: { folder: '100ricoh', name: 'r0000001.jpg' } })]), /same archive path/);
});

test('files: archive count and total byte limits are enforced before reading payloads', async () => {
  let reads = 0;
  const fakeBlob = { size: 128 * 1024 * 1024, type: 'image/jpeg', arrayBuffer() { reads++; throw new Error('must not read'); } };
  await assert.rejects(buildArchive([entry({ blob: fakeBlob }), entry({ blob: fakeBlob }), entry({ blob: fakeBlob })]), /256 MiB/);
  await assert.rejects(buildArchive(Array.from({ length: 49 }, () => entry({ blob: fakeBlob }))), /48/);
  assert.equal(reads, 0);
});

test('files: cancellation stops packaging without losing or altering source Blobs', async () => {
  const controller = new AbortController(); const originalEntry = entry();
  await assert.rejects(buildArchive([originalEntry, entry({ photo: { folder: '101RICOH', name: 'R.JPG' } })], { signal: controller.signal, onProgress: () => controller.abort() }));
  assert.deepEqual(Buffer.from(await originalEntry.blob.arrayBuffer()), image);
});

test('files: empty, missing, oversized and unsafe entries fail clearly', async () => {
  await assert.rejects(buildArchive([]), /at least one/);
  await assert.rejects(buildArchive([entry({ blob: null })]), /missing/);
  await assert.rejects(buildArchive([entry({ sourceId: '' })]), /identity/);
  await assert.rejects(buildArchive([entry({ photo: { folder: '100RICOH', name: '../R.JPG' } })]), /unsafe/);
  await assert.rejects(buildArchive([entry({ blob: { size: 129 * 1024 * 1024, type: 'image/jpeg' } })]), /size limit/);
});

test('files: large-file CRC work yields so cancellation interrupts preparation between chunks', async () => {
  const controller = new AbortController(); let yields = 0;
  const cancellableContext = { ...context, setTimeout: (fn, ms) => { yields++; controller.abort(); return setTimeout(fn, ms); } };
  runInNewContext(code, cancellableContext);
  const large = new Blob([image, new Uint8Array(2 * 1024 * 1024)], { type: 'image/jpeg' });
  await assert.rejects(cancellableContext.GRTransferFiles.buildArchive([entry({ blob: large })], { signal: controller.signal }), e => e.name === 'AbortError');
  assert.equal(yields, 1); assert.equal(large.size, image.length + 2 * 1024 * 1024);
});

test('standalone receipt hashes retained originals without an archive or byte transformations', async () => {
  const e = entry();
  const result = await context.GRTransferFiles.buildReceipt(e, { createdAt: new Date('2026-10-04T00:00:00Z') });
  assert.equal(result.receipt.sha256, hash(image)); assert.equal(result.receipt.bytes, image.length);
  assert.equal(result.receipt.downloadFilename, downloadName(e.photo));
  assert.equal(result.filename, `${downloadName(e.photo)}.receipt.json`);
  assert.equal(JSON.parse(await result.blob.text()).sha256, hash(image));
  assert.deepEqual(Buffer.from(await e.blob.arrayBuffer()), image);
  assert.match(result.receipt.checksumScope, /not an independent camera checksum/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(context.GRTransferFiles.buildReceipt(e, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(context.GRTransferFiles.buildReceipt(entry({ blob: new Blob([]) })), /retained original/);
});
