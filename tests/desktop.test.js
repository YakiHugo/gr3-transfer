import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { createBridge } from '../src/server.js';

async function launch(t, port) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'camera launcher test '));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['src', 'fixtures', 'package.json']) await cp(new URL(`../${name}`, import.meta.url), path.join(root, name), { recursive: true });
  await cp(new URL('../scripts/launch-desktop.mjs', import.meta.url), path.join(root, 'launch-desktop.mjs'));
  const child = spawn(process.execPath, [path.join(root, 'launch-desktop.mjs')], { env: { ...process.env, PORT: String(port), CAMERA_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const [code] = await once(child, 'exit');
  return { code, output };
}

test('desktop launcher rejects invalid port without starting or opening a browser', async t => {
  const result = await launch(t, 'invalid');
  assert.equal(result.code, 1);
  assert.match(result.output, /PORT 必须是/);
});

test('desktop repeated launch never kills or replaces the existing local bridge', async t => {
  const server = await createBridge(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const result = await launch(t, port);
  assert.equal(result.code, 1);
  assert.match(result.output, /已被占用/);
  assert.match(result.output, /未停止任何已有进程/);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).connected, false);
});

test('desktop packager refuses to replace an existing output directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'camera package refusal '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, `camera-transfer-${process.platform}-${process.arch}`));
  const child = spawn(process.execPath, [new URL('../scripts/package-desktop.mjs', import.meta.url).pathname, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', b => { error += b; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1); assert.match(error, /Output already exists/);
});

test('desktop shutdown does not wait for or terminate a long-running browser opener', { skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'camera opener test '));
  let child, openerPid;
  t.after(async () => {
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
    // This is our fixture sleep process, never an actual browser.
    if (openerPid) { try { process.kill(openerPid, 'SIGTERM'); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  for (const name of ['src', 'fixtures', 'package.json']) await cp(new URL(`../${name}`, import.meta.url), path.join(root, name), { recursive: true });
  await cp(new URL('../scripts/launch-desktop.mjs', import.meta.url), path.join(root, 'launch-desktop.mjs'));
  const bin = path.join(root, 'bin'); await mkdir(bin);
  const pidFile = path.join(root, 'opener.pid');
  await writeFile(path.join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open'), '#!/bin/sh\nprintf "%s" "$$" > "$OPENER_PID_FILE"\nexec sleep 30\n', { mode: 0o755 });
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  child = spawn(process.execPath, [path.join(root, 'launch-desktop.mjs')], { env: { ...process.env, PORT: String(port), CAMERA_NO_OPEN: '0', PATH: `${bin}${path.delimiter}${process.env.PATH}`, OPENER_PID_FILE: pidFile }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { openerPid = Number(await readFile(pidFile, 'utf8')); if (openerPid) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(openerPid, 'Controlled opener did not start');
  const exit = once(child, 'exit'); child.kill('SIGTERM');
  const timeout = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Launcher waited for browser opener')), 1000); timer.unref(); });
  const [code] = await Promise.race([exit, timeout]);
  assert.equal(code, 0);
  assert.doesNotThrow(() => process.kill(openerPid, 0), 'Launcher must not kill the opened browser');
});
