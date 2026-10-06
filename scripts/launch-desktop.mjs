import { spawn } from 'node:child_process';
import { createBridge } from './src/server.js';

const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('PORT 必须是 1024 到 65535 之间的整数。');
  process.exitCode = 1;
} else {
  const server = await createBridge();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用。请关闭另一个传输程序窗口，或使用其他 PORT。未停止任何已有进程。`
      : '本机程序无法启动，未修改网络设置。');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`GR Relay · 相机原片传输\n${url}\n\n请保持此终端开启。先保存原片，再按 Control-C 停止程序。\n仅供本机使用；点击「连接相机」前不会访问相机。\n`);
    if (process.env.CAMERA_NO_OPEN === '1') return;
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
    if (!command) { console.log(`请在浏览器中打开 ${url}。`); return; }
    const child = spawn(command, [url], { stdio: 'ignore', detached: true });
    // A desktop opener may stay alive as long as the browser. Never own or kill it.
    child.unref();
    child.on('error', () => console.log(`请在浏览器中打开 ${url}。`));
    child.on('exit', code => { if (code) console.log(`请在浏览器中打开 ${url}。`); });
  });
  const stop = () => { server.closeAllConnections(); server.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
