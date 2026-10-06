import { cp, mkdir, readFile, writeFile, chmod, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.argv[2] || path.join(root, 'dist'));
const label = `camera-transfer-${process.platform}-${process.arch}`;
const target = path.join(output, label);
// Never replace an existing installation or artifact directory.
try { await access(target); throw new Error(`Output already exists: ${target}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(target, { recursive: true });
for (const entry of ['src', 'public', 'fixtures']) await cp(path.join(root, entry), path.join(target, entry), { recursive: true });
await mkdir(path.join(target, 'runtime'));
await cp(process.execPath, path.join(target, 'runtime', 'node'));
await chmod(path.join(target, 'runtime', 'node'), 0o755);
await writeFile(path.join(target, 'package.json'), JSON.stringify({ type: 'module', private: true }));
const license = new URL('../LICENSE', `file://${process.execPath}`);
// Official setup-node distributions keep LICENSE next to bin/. Local distributions may not.
const licenseCandidates = [fileURLToPath(license), path.join(path.dirname(process.execPath), 'LICENSE'), path.join(root, 'node-runtime-LICENSE')];
let runtimeLicense;
for (const candidate of licenseCandidates) { try { runtimeLicense = await readFile(candidate); break; } catch {} }
if (!runtimeLicense) throw new Error('Node runtime LICENSE missing. Supply the official distribution license as node-runtime-LICENSE before packaging.');
await writeFile(path.join(target, 'NODE-LICENSE.txt'), runtimeLicense);
await cp(path.join(root, 'scripts', 'launch-desktop.mjs'), path.join(target, 'launch-desktop.mjs'));
const launcher = '#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexec ./runtime/node ./launch-desktop.mjs\n';
await writeFile(path.join(target, 'Start Camera Transfer.command'), launcher, { mode: 0o755 });
await writeFile(path.join(target, 'START-HERE.txt'), `GR Relay · 便携桌面测试版\n\n1. 解压完整文件夹，保持 runtime、src、public 和 fixtures 在一起。\n2. macOS 双击 Start Camera Transfer.command；Linux 可在终端运行同一个文件。\n3. 浏览器打开本机页面后，可点击「先试试看」。真实传输前，请手动加入相机 Wi-Fi，再点击「连接相机」。\n4. 传输期间保持终端开启。先保存原片并检查下载文件夹，再关闭页面。终端中按 Control-C 可停止程序。\n\n已包含 Node 运行时，无需 npm、账号、云端上传或互联网连接。\n此测试版未签名，可能受到 macOS 安全限制。不要绕过安全警告；可使用文档中的 Node 源码运行方式，或等待签名发布版。\n此包不代表已经通过真实相机、Mac 或手机验证，仅支持 ${process.platform}/${process.arch}。\n仅监听这台电脑的本机地址，不提供手机访问。\n`);
execFileSync(path.join(target, 'runtime', 'node'), ['--check', path.join(target, 'launch-desktop.mjs')]);
const archive = path.join(output, `${label}.tar.gz`);
try { await access(archive); throw new Error(`Archive already exists: ${archive}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
execFileSync('tar', ['-czf', archive, '-C', output, label]);
const sha = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${sha}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ archive, sha256: sha, platform: process.platform, arch: process.arch, node: process.version }));
