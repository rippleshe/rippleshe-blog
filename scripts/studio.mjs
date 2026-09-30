import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  INBOX,
  createGardenNote,
  createFolio,
  listGardenNotes,
  readFolios,
  readLibrary,
  removeFolio,
  removeGardenNote,
  removeLibraryItem,
  syncInbox,
  updateFolio,
  updateGalleryLayout,
  updateGardenNote,
  updateLibraryItem,
} from './content-core.mjs';

const PORT = 4175;
const PAGE_FILE = path.join(import.meta.dirname, 'studio.html');
const PUBLIC_ROOT = path.resolve(import.meta.dirname, '..', 'public');
await fs.mkdir(INBOX, { recursive: true });
const html = await fs.readFile(PAGE_FILE, 'utf8');
const ROOT = path.resolve(import.meta.dirname, '..');
let releaseJob = { status: 'idle', startedAt: null, finishedAt: null, code: null, lines: [] };

function startRelease() {
  if (releaseJob.status === 'running') return releaseJob;
  releaseJob = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, code: null, lines: [] };
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm release:site'], { cwd: ROOT, windowsHide: true })
    : spawn('pnpm', ['release:site'], { cwd: ROOT });
  const push = (chunk) => {
    const text = String(chunk || '').replace(/\x1b\[[0-9;]*m/g, '');
    releaseJob.lines.push(...text.split(/\r?\n/).filter(Boolean));
    if (releaseJob.lines.length > 80) releaseJob.lines = releaseJob.lines.slice(-80);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (error) => {
    push(error.message);
    releaseJob.status = 'failed';
    releaseJob.finishedAt = new Date().toISOString();
    releaseJob.code = -1;
  });
  child.on('exit', (code) => {
    releaseJob.status = code === 0 ? 'success' : 'failed';
    releaseJob.finishedAt = new Date().toISOString();
    releaseJob.code = code;
  });
  return releaseJob;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname.startsWith('/preview/')) {
    const relative = decodeURIComponent(url.pathname.slice('/preview/'.length)).replaceAll('\\', '/');
    const file = path.resolve(PUBLIC_ROOT, relative);
    if (!file.startsWith(PUBLIC_ROOT + path.sep)) return sendJson(res, 403, { error: '无效的预览路径' });
    try {
      const body = await fs.readFile(file);
      const ext = path.extname(file).toLowerCase();
      const types = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.avif': 'image/avif', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(body);
    } catch {
      return sendJson(res, 404, { error: '预览文件不存在' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/library') {
    return sendJson(res, 200, await readLibrary());
  }

  if (req.method === 'GET' && url.pathname === '/api/notes') {
    return sendJson(res, 200, { notes: await listGardenNotes() });
  }

  if (req.method === 'GET' && url.pathname === '/api/folios') {
    return sendJson(res, 200, await readFolios());
  }

  if (req.method === 'POST' && url.pathname === '/api/folio') {
    const body = await bodyJson(req);
    if (!body) return sendJson(res, 400, { error: '无效的册页请求' });
    try { return sendJson(res, 200, { folio: await createFolio(body) }); }
    catch (error) { return sendJson(res, 400, { error: error.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/folio/update') {
    const body = await bodyJson(req);
    if (!body?.id) return sendJson(res, 400, { error: '缺少册页标识' });
    try {
      const folio = await updateFolio(body.id, body);
      return sendJson(res, folio ? 200 : 404, { folio, error: folio ? undefined : '没有找到这张册页' });
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/folio/delete') {
    const body = await bodyJson(req);
    if (!body?.id) return sendJson(res, 400, { error: '缺少册页标识' });
    const folio = await removeFolio(body.id);
    return sendJson(res, folio ? 200 : 404, { folio, error: folio ? undefined : '没有找到这张册页' });
  }

  if (req.method === 'GET' && url.pathname === '/api/release') {
    return sendJson(res, 200, releaseJob);
  }

  if (req.method === 'POST' && url.pathname === '/api/release') {
    if (releaseJob.status === 'running') return sendJson(res, 409, { error: '已经有一次发布正在进行', ...releaseJob });
    return sendJson(res, 202, startRelease());
  }

  if (req.method === 'POST' && url.pathname === '/api/note') {
    const body = await bodyJson(req);
    if (!body) return sendJson(res, 400, { error: '无效的文字请求' });
    try {
      return sendJson(res, 200, { note: await createGardenNote(body) });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/note/update') {
    const body = await bodyJson(req);
    if (!body?.id) return sendJson(res, 400, { error: '缺少文字标识' });
    try {
      const note = await updateGardenNote(body.id, body);
      return sendJson(res, note ? 200 : 404, { note, error: note ? undefined : '没有找到这篇文字' });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/note/delete') {
    const body = await bodyJson(req);
    if (!body?.id) return sendJson(res, 400, { error: '缺少文字标识' });
    try {
      const note = await removeGardenNote(body.id);
      return sendJson(res, note ? 200 : 404, { note, error: note ? undefined : '没有找到这篇文字' });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/gallery') {
    const body = await bodyJson(req);
    if (!Array.isArray(body?.items)) return sendJson(res, 400, { error: '无效的画廊编排' });
    return sendJson(res, 200, { items: await updateGalleryLayout(body.items) });
  }

  if (req.method === 'POST' && url.pathname === '/api/update') {
    const body = await bodyJson(req);
    if (!body?.id) return sendJson(res, 400, { error: '无效的更新请求' });
    try {
      const item = await updateLibraryItem(body.id, body);
      return sendJson(res, item ? 200 : 404, { item, error: item ? undefined : '没有找到这项素材' });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/delete') {
    const body = await bodyJson(req);
    if (!body?.id) return sendJson(res, 400, { error: '无效的删除请求' });
    try {
      const item = await removeLibraryItem(body.id);
      return sendJson(res, item ? 200 : 404, { item, error: item ? undefined : '没有找到这项素材' });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/upload') {
    try {
      const webReq = new Request('http://127.0.0.1:' + PORT + '/upload', {
        method: 'POST',
        headers: req.headers,
        body: Readable.toWeb(req),
        duplex: 'half',
      });
      const form = await webReq.formData();
      const uploads = form.getAll('files').filter((item) => item && typeof item.arrayBuffer === 'function');
      if (!uploads.length) return sendJson(res, 400, { error: '还没有选择文件' });

      const common = {
        date: form.get('date') || '',
        title: uploads.length === 1 ? String(form.get('title') || '') : '',
        tags: String(form.get('tags') || ''),
        featured: form.get('featured') === 'on',
        publish: form.get('publish') === 'on',
        display: form.get('display') === 'contain' ? 'contain' : 'cover',
      };

      let index = 0;
      for (const file of uploads) {
        const safeName = path.basename(file.name).replace(/[\\/:*?"<>|]/g, '-');
        const target = path.join(INBOX, String(Date.now()) + '-' + String(index++).padStart(2, '0') + '-' + safeName);
        await fs.writeFile(target, Buffer.from(await file.arrayBuffer()));
        await fs.writeFile(target + '.meta.json', JSON.stringify(common, null, 2));
      }

      const imported = await syncInbox();
      return sendJson(res, 200, {
        message: '已经收入 ' + imported.length + ' 项。可以继续去编排画廊，或留在这里再添一点。',
        imported,
      });
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Rippleshe 内容台：http://127.0.0.1:' + PORT);
});

