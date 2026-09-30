import { spawn } from 'node:child_process';
import net from 'node:net';

const isWindows = process.platform === 'win32';

function startDevServer() {
  return isWindows
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm dev'], { stdio: 'inherit', windowsHide: true })
    : spawn('pnpm', ['dev'], { stdio: 'inherit' });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(300);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function probe(url, accept) {
  const parsed = new URL(url);
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  if (!(await portOpen(port))) return { occupied: false, ours: false };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(650), cache: 'no-store' });
      const body = await response.text();
      return { occupied: true, ours: accept(response, body) };
    } catch {
      if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 180));
    }
  }
  return { occupied: true, ours: false };
}

const services = [
  {
    label: '网站',
    url: 'http://127.0.0.1:4173/',
    probeUrl: 'http://127.0.0.1:4173/',
    accept: (_response, body) => body.includes('<title>Rippleshe</title>') || body.includes('RIPPLESHE'),
    start: startDevServer,
  },
  {
    label: '内容台',
    url: 'http://127.0.0.1:4175/',
    probeUrl: 'http://127.0.0.1:4175/',
    accept: (_response, body) => body.includes('Rippleshe · 私人内容台') || body.includes('拾页'),
    start: () => spawn(process.execPath, ['scripts/studio.mjs'], { stdio: 'inherit', windowsHide: true }),
  },
  {
    label: '来客簿',
    url: 'http://127.0.0.1:4185/',
    probeUrl: 'http://127.0.0.1:4185/health',
    accept: (response, body) => response.ok && body.includes('"ok":true'),
    start: () => spawn(process.execPath, ['scripts/guestbook-server.mjs'], { stdio: 'inherit', windowsHide: true }),
  },
];

const children = [];
let failed = false;

console.log('\nRippleshe garden');
for (const service of services) {
  const state = await probe(service.probeUrl, service.accept);
  if (state.occupied && !state.ours) {
    console.error(`  × ${service.label.padEnd(4)} ${service.url} 端口已被别的程序占用`);
    failed = true;
    continue;
  }
  if (state.ours) {
    console.log(`  ✓ ${service.label.padEnd(4)} ${service.url} 已在运行，直接沿用`);
    continue;
  }
  const child = service.start();
  children.push({ child, label: service.label });
  console.log(`  → ${service.label.padEnd(4)} ${service.url} 正在启动`);
}

if (failed) {
  for (const { child } of children) {
    if (child.killed || !child.pid) continue;
    if (isWindows) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  }
  process.exit(1);
}

console.log('\n按 Ctrl+C 只会停掉这次新启动的服务；已经存在的服务不会被误关。\n');

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (child.killed || !child.pid) continue;
    if (isWindows) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  }
}

process.on('SIGINT', () => { stop(); setTimeout(() => process.exit(0), 120); });
process.on('SIGTERM', () => { stop(); setTimeout(() => process.exit(0), 120); });

for (const { child, label } of children) {
  child.on('error', (error) => {
    console.error(`${label}启动失败：`, error.message);
    stop();
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    if (!stopping && code && code !== 0) {
      console.error(`${label}退出了（code ${code}）。`);
      stop();
      process.exitCode = code;
    }
  });
}

if (children.length === 0) {
  console.log('三个服务都已经在运行。');
}
