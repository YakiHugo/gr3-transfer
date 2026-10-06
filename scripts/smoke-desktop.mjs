import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { once } from 'node:events';
const root = path.resolve(process.argv[2] || 'dist');
const folder = (await readdir(root)).find(name => name === `camera-transfer-${process.platform}-${process.arch}`);
assert.ok(folder, 'Native runtime bundle missing');
const archivePath = path.join(root, `${folder}.tar.gz`);
const checksum = (await readFile(`${archivePath}.sha256`, 'utf8')).split(/\s+/)[0];
assert.equal(createHash('sha256').update(await readFile(archivePath)).digest('hex'), checksum, 'Archive checksum mismatch');
const extracted = await mkdtemp(path.join(os.tmpdir(), 'camera portable smoke '));
execFileSync('tar', ['-xzf', path.join(root, `${folder}.tar.gz`), '-C', extracted]);
const target = path.join(extracted, folder);
const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const child = spawn(path.join(target, 'Start Camera Transfer.command'), [], { env: { ...process.env, PORT: String(port), CAMERA_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
const base = `http://127.0.0.1:${port}`;
try {
  let session;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Launcher exited: ${output}`);
    try { session = await (await fetch(`${base}/api/session`)).json(); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(session, `No startup response: ${output}`); assert.equal(session.connected, false); assert.equal(session.localOnly, true);
  assert.equal((await fetch(base)).status, 200);
  const result = await fetch(`${base}/api/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, Origin: base }, body: JSON.stringify({ mode: 'demo' }) });
  assert.equal(result.status, 200);
  const list = await (await fetch(`${base}/api/photos`)).json(); assert.equal(list.photos.length, 12);
  const photo = list.photos[0];
  const actual = Buffer.from(await (await fetch(base + photo.originalUrl)).arrayBuffer());
  const expected = await readFile(path.join(target, 'fixtures', `${photo.id}.jpg`));
  assert.deepEqual(actual, expected);
  console.log(`Packaged ${process.platform}/${process.arch} runtime passed startup/demo/original SHA-256 ${createHash('sha256').update(actual).digest('hex')}`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Launcher did not stop')); }, 3000).unref())]);
  }
  await rm(extracted, { recursive: true, force: true });
}
