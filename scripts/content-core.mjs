import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const INBOX = path.join(ROOT, 'content-inbox');
const DATA_FILE = path.join(ROOT, 'src', 'data', 'library.json');
const FOLIOS_FILE = path.join(ROOT, 'src', 'data', 'folios.json');
const PHOTO_ROOT = path.join(ROOT, 'public', 'uploads', 'photos');
const DOC_ROOT = path.join(ROOT, 'public', 'uploads', 'documents');
const GARDEN_ROOT = path.join(ROOT, 'src', 'content', 'garden');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff']);
const DOC_EXTS = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.md', '.zip']);

function safeSlug(input) {
  return input.normalize('NFKC').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'untitled';
}

function parseDate(input, fallback) {
  if (input) {
    const d = new Date(input);
    if (!Number.isNaN(d.valueOf())) return d;
  }
  return fallback;
}

async function hashFile(file) {
  const buffer = await fs.readFile(file);
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

async function readMeta(file) {
  try {
    return JSON.parse(await fs.readFile(`${file}.meta.json`, 'utf8'));
  } catch {
    return {};
  }
}

async function allFiles(dir) {
  const out = [];
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('_') || entry.name.endsWith('.meta.json') || entry.name === 'README.txt') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await allFiles(full));
      else out.push(full);
    }
  } catch {}
  return out;
}

export async function readLibrary() {
  return JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
}

export async function readFolios() {
  try { return JSON.parse(await fs.readFile(FOLIOS_FILE, 'utf8')); }
  catch { return { version: 1, folios: [] }; }
}

async function writeFolios(data) {
  data.folios.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.title.localeCompare(b.title, 'zh-CN'));
  await fs.writeFile(FOLIOS_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function writeLibrary(data) {
  data.items.sort((a, b) => new Date(b.date).valueOf() - new Date(a.date).valueOf());
  await fs.writeFile(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function syncInbox() {
  await Promise.all([fs.mkdir(INBOX, { recursive: true }), fs.mkdir(PHOTO_ROOT, { recursive: true }), fs.mkdir(DOC_ROOT, { recursive: true })]);
  const data = await readLibrary();
  const known = new Set(data.items.map((item) => item.sourceHash).filter(Boolean));
  let nextGalleryOrder = Math.max(-1, ...data.items.filter((item) => item.type === 'photo').map((item) => Number.isFinite(item.galleryOrder) ? item.galleryOrder : -1)) + 1;
  const imported = [];

  for (const file of await allFiles(INBOX)) {
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTS.has(ext) && !DOC_EXTS.has(ext)) continue;
    const sourceHash = await hashFile(file);
    if (known.has(sourceHash)) continue;

    const stat = await fs.stat(file);
    const meta = await readMeta(file);
    const date = parseDate(meta.date, stat.mtime);
    const year = String(date.getFullYear());
    const title = (meta.title || path.basename(file, ext)).trim();
    const tags = Array.isArray(meta.tags) ? meta.tags : String(meta.tags || '').split(/[,，+]/).map((s) => s.trim()).filter(Boolean);
    const id = `${IMAGE_EXTS.has(ext) ? 'p' : 'd'}-${date.toISOString().slice(0,10).replaceAll('-','')}-${sourceHash.slice(0,8)}`;
    const common = { id, title, date: date.toISOString(), tags, featured: Boolean(meta.featured), publish: meta.publish !== false, sourceHash, sourceFile: path.basename(file) };

    if (IMAGE_EXTS.has(ext)) {
      const outDir = path.join(PHOTO_ROOT, year);
      await fs.mkdir(outDir, { recursive: true });
      const srcName = `${id}.webp`;
      const thumbName = `${id}-thumb.webp`;
      const imageBuffer = await fs.readFile(file);
      const image = sharp(imageBuffer, { failOn: 'none' }).rotate();
      const info = await image.metadata();
      await image.clone().webp({ quality: 88 }).toFile(path.join(outDir, srcName));
      await image.clone().resize({ width: 900, withoutEnlargement: true }).webp({ quality: 80 }).toFile(path.join(outDir, thumbName));
      const ratio = info.width && info.height ? info.width / info.height : 1;
      const gallerySize = ratio > 1.65 ? 'wide' : ratio < .78 ? 'narrow' : 'standard';
      const galleryRatio = ratio > 1.8 ? 'cinematic' : ratio > 1.12 ? 'landscape' : ratio < .82 ? 'portrait' : 'square';
      imported.push({ ...common, type: 'photo', src: `/uploads/photos/${year}/${srcName}`, thumb: `/uploads/photos/${year}/${thumbName}`, width: info.width, height: info.height, display: meta.display === 'contain' ? 'contain' : 'cover', galleryOrder: nextGalleryOrder++, gallerySize, galleryRatio });
    } else {
      const outDir = path.join(DOC_ROOT, year);
      await fs.mkdir(outDir, { recursive: true });
      const target = `${id}-${safeSlug(title)}${ext}`;
      await fs.copyFile(file, path.join(outDir, target));
      imported.push({ ...common, type: 'document', src: `/uploads/documents/${year}/${target}`, ext: ext.slice(1).toUpperCase(), size: stat.size });
    }
    known.add(sourceHash);
  }

  if (imported.length) {
    data.items.push(...imported);
    await writeLibrary(data);
  }
  return imported;
}

function publicPath(urlPath) {
  if (!urlPath?.startsWith('/uploads/')) return null;
  return path.join(ROOT, 'public', ...urlPath.split('/').filter(Boolean));
}

export async function updateLibraryItem(id, patch) {
  const data = await readLibrary();
  const item = data.items.find((entry) => entry.id === id);
  if (!item) return null;
  if (typeof patch.title === 'string' && patch.title.trim()) item.title = patch.title.trim();
  if (patch.date) item.date = parseDate(patch.date, new Date(item.date)).toISOString();
  if (Array.isArray(patch.tags)) item.tags = patch.tags.map((tag) => String(tag).trim()).filter(Boolean);
  if (typeof patch.featured === 'boolean') item.featured = patch.featured;
  if (patch.publish === false && item.publish !== false) await assertCanHideFromPublicFolio('library', id);
  if (typeof patch.publish === 'boolean') item.publish = patch.publish;
  if (item.type === 'photo' && (patch.display === 'cover' || patch.display === 'contain')) item.display = patch.display;
  if (item.type === 'photo' && ['narrow', 'standard', 'wide', 'hero'].includes(patch.gallerySize)) item.gallerySize = patch.gallerySize;
  if (item.type === 'photo' && ['portrait', 'square', 'landscape', 'cinematic'].includes(patch.galleryRatio)) item.galleryRatio = patch.galleryRatio;
  await writeLibrary(data);
  return item;
}

export async function updateGalleryLayout(layout) {
  if (!Array.isArray(layout)) return [];
  const data = await readLibrary();
  const photoMap = new Map(data.items.filter((item) => item.type === 'photo').map((item) => [item.id, item]));
  layout.forEach((entry, index) => {
    const item = photoMap.get(entry?.id);
    if (!item) return;
    item.galleryOrder = index;
    if (['narrow', 'standard', 'wide', 'hero'].includes(entry.gallerySize)) item.gallerySize = entry.gallerySize;
    if (['portrait', 'square', 'landscape', 'cinematic'].includes(entry.galleryRatio)) item.galleryRatio = entry.galleryRatio;
  });
  await writeLibrary(data);
  return layout.filter((entry) => photoMap.has(entry?.id));
}

async function assertCanHideFromPublicFolio(source, ref) {
  const data = await readFolios();
  const normalized = String(ref || '').replace(/\.md$/i, '');
  const folio = data.folios.find((entry) => entry.publish !== false && (entry.items || []).some((item) => item.source === source && String(item.ref).replace(/\.md$/i, '') === normalized));
  if (folio) throw new Error(`这项内容正在公开册页《${folio.title}》里。先把册页设为未展示，或从册页移出这项内容。`);
}

async function assertNotBoundToFolio(source, ref) {
  const data = await readFolios();
  const normalized = String(ref || '').replace(/\.md$/i, '');
  const folio = data.folios.find((entry) => (entry.items || []).some((item) => item.source === source && String(item.ref).replace(/\.md$/i, '') === normalized));
  if (folio) throw new Error(`这项内容还装订在《${folio.title}》里。先从册页移出，再删除原内容。`);
}

export async function removeLibraryItem(id) {
  await assertNotBoundToFolio('library', id);
  const data = await readLibrary();
  const index = data.items.findIndex((entry) => entry.id === id);
  if (index < 0) return null;
  const [item] = data.items.splice(index, 1);
  for (const value of [item.src, item.thumb]) {
    const file = publicPath(value);
    if (file) await fs.rm(file, { force: true }).catch(() => {});
  }
  if (item.sourceFile) {
    await fs.rm(path.join(INBOX, item.sourceFile), { force: true }).catch(() => {});
    await fs.rm(path.join(INBOX, `${item.sourceFile}.meta.json`), { force: true }).catch(() => {});
  }
  await writeLibrary(data);
  return item;
}

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function gardenNotePath(id) {
  const rel = String(id || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..')) return null;
  const file = path.resolve(GARDEN_ROOT, rel.endsWith('.md') ? rel : rel + '.md');
  const root = path.resolve(GARDEN_ROOT) + path.sep;
  return file.startsWith(root) ? file : null;
}

function parseGardenNote(file, raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const front = match[1].replace(/\r/g, '');
  const body = match[2].replace(/\r/g, '').trimEnd();
  const lines = front.split('\n');
  const meta = {};
  for (let i = 0; i < lines.length; i++) {
    const hit = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!hit) continue;
    const key = hit[1];
    const rawValue = hit[2];
    if (key === 'tags') {
      const tags = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        const tag = lines[++i].match(/^\s*-\s*(.*)$/)?.[1];
        if (tag) {
          try { tags.push(JSON.parse(tag)); } catch { tags.push(tag.replace(/^['"]|['"]$/g, '')); }
        }
      }
      meta.tags = tags;
      continue;
    }
    if (rawValue === 'true' || rawValue === 'false') meta[key] = rawValue === 'true';
    else {
      try { meta[key] = JSON.parse(rawValue); } catch { meta[key] = rawValue; }
    }
  }
  const rel = path.relative(GARDEN_ROOT, file).replaceAll('\\', '/');
  const fallbackTitle = path.basename(file, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '').replaceAll('-', ' ');
  return {
    id: rel,
    title: String(meta.title || fallbackTitle),
    date: String(meta.date || ''),
    updated: String(meta.updated || ''),
    kind: String(meta.kind || '小札'),
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    publish: meta.publish !== false,
    featured: Boolean(meta.featured),
    body,
    excerpt: body.replace(/[#*_>\[\]\x60~-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120),
    href: '/garden/' + rel.replace(/\.md$/, '') + '/',
  };
}

export async function listGardenNotes() {
  const notes = [];
  for (const file of await allFiles(GARDEN_ROOT)) {
    if (path.extname(file).toLowerCase() !== '.md') continue;
    const note = parseGardenNote(file, await fs.readFile(file, 'utf8'));
    if (note) notes.push(note);
  }
  return notes.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.title.localeCompare(b.title, 'zh-CN'));
}

function patchFrontmatter(front, input) {
  const lines = front.replace(/\r/g, '').split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const hit = line.match(/^([A-Za-z_][\w-]*):/);
    if (hit) {
      current = { key: hit[1], lines: [line] };
      sections.push(current);
    } else if (current) current.lines.push(line);
    else sections.push({ key: '', lines: [line] });
  }
  const tags = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? input.date : localDateString();
  const kind = ['小札','诗','词','短文','信','摘记'].includes(input.kind) ? input.kind : '小札';
  const values = new Map([
    ['title', ['title: ' + JSON.stringify(String(input.title || '').trim() || '无题小札')]],
    ['date', ['date: ' + date]],
    ...(input.updated ? [['updated', ['updated: ' + String(input.updated)]]] : []),
    ['kind', ['kind: ' + kind]],
    ['tags', tags.length ? ['tags:', ...tags.map((tag) => '  - ' + JSON.stringify(tag))] : ['tags: []']],
    ['publish', ['publish: ' + String(input.publish !== false)]],
    ['featured', ['featured: ' + String(Boolean(input.featured))]],
  ]);
  const seen = new Set();
  const out = [];
  for (const section of sections) {
    if (values.has(section.key)) {
      if (!seen.has(section.key)) out.push(...values.get(section.key));
      seen.add(section.key);
    } else out.push(...section.lines);
  }
  for (const [key, value] of values) if (!seen.has(key)) out.push(...value);
  return out.join('\n').trim();
}

export async function updateGardenNote(id, input) {
  const file = gardenNotePath(id);
  if (!file) return null;
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return null; }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('这篇文字的 frontmatter 无法识别。');
  const body = String(input.body || '').replace(/\r\n?/g, '\n').trim();
  if (!body) throw new Error('正文还没有写。');
  if (input.publish === false) await assertCanHideFromPublicFolio('garden', id);
  const front = patchFrontmatter(match[1], { ...input, updated: localDateString() });
  await fs.writeFile(file, '---\n' + front + '\n---\n' + body + '\n', 'utf8');
  return parseGardenNote(file, await fs.readFile(file, 'utf8'));
}

export async function removeGardenNote(id) {
  await assertNotBoundToFolio('garden', id);
  const file = gardenNotePath(id);
  if (!file) return null;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const note = parseGardenNote(file, raw);
    await fs.rm(file);
    return note;
  } catch {
    return null;
  }
}

export async function createGardenNote(input) {
  await fs.mkdir(GARDEN_ROOT, { recursive: true });
  const kinds = new Set(['小札', '诗', '词', '短文', '信', '摘记']);
  const title = String(input.title || '').trim() || '无题小札';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? String(input.date) : localDateString();
  const kind = kinds.has(input.kind) ? input.kind : '小札';
  const tags = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  const body = String(input.body || '').replace(/\r\n?/g, '\n').trim();
  if (!body) throw new Error('正文还没有写。');

  const stem = `${date}-${safeSlug(title)}`;
  let filename = `${stem}.md`;
  let counter = 2;
  while (true) {
    try {
      await fs.access(path.join(GARDEN_ROOT, filename));
      filename = `${stem}-${counter++}.md`;
    } catch {
      break;
    }
  }

  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `date: ${date}`,
    ...(tags.length ? ['tags:', ...tags.map((tag) => `  - ${JSON.stringify(tag)}`)] : ['tags: []']),
    `kind: ${kind}`,
    'lang: zh',
    `publish: ${input.publish !== false}`,
    `featured: ${Boolean(input.featured)}`,
    '---',
    '',
  ].join('\n');

  await fs.writeFile(path.join(GARDEN_ROOT, filename), `${frontmatter}${body}\n`, 'utf8');
  return {
    filename,
    title,
    kind,
    date,
    tags,
    href: `/garden/${filename.replace(/\.md$/, '').toLowerCase()}/`,
  };
}

function normalizeFolioItems(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    const source = item?.source === 'garden' ? 'garden' : item?.source === 'library' ? 'library' : '';
    const ref = String(item?.ref || '').replace(/\.md$/i, '').trim();
    const key = source && ref ? source + ':' + ref : '';
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [{ source, ref }];
  });
}

async function ensureFolioItemsVisible(items) {
  const [library, notes] = await Promise.all([readLibrary(), listGardenNotes()]);
  const libraryMap = new Map(library.items.map((item) => [item.id, item]));
  const noteMap = new Map(notes.map((note) => [String(note.id).replace(/\.md$/i, ''), note]));
  for (const item of items) {
    if (item.source === 'library' && libraryMap.get(item.ref)?.publish === false) throw new Error('要把册页放进日录，其中的素材需要先设为“站内展示”；或者先把册页设为未展示。');
    if (item.source === 'garden' && noteMap.get(item.ref)?.publish === false) throw new Error('要把册页放进日录，其中的文字需要先公开；或者先把册页设为未展示。');
  }
}

function ensureFolioItemsAvailable(data, items, ignoreId = '') {
  const used = new Map();
  for (const folio of data.folios) {
    if (folio.id === ignoreId) continue;
    for (const item of folio.items || []) used.set(`${item.source}:${String(item.ref).replace(/\.md$/i, '')}`, folio.title);
  }
  const conflict = items.find((item) => used.has(`${item.source}:${item.ref}`));
  if (conflict) throw new Error(`这项内容已经装订在《${used.get(`${conflict.source}:${conflict.ref}`)}》里。先从原册页移出，再收进新的册页。`);
}

export async function createFolio(input) {
  const data = await readFolios();
  const title = String(input.title || '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? String(input.date) : localDateString();
  const intro = String(input.intro || '').trim();
  const items = normalizeFolioItems(input.items);
  if (!title) throw new Error('册页还没有名字。');
  if (items.length < 2) throw new Error('至少选两项内容，才值得收成一页。');
  ensureFolioItemsAvailable(data, items);
  if (input.publish !== false) await ensureFolioItemsVisible(items);
  const base = safeSlug(date + '-' + title).toLowerCase();
  let id = base;
  let counter = 2;
  while (data.folios.some((folio) => folio.id === id)) id = base + '-' + counter++;
  const folio = { id, title, date, intro, publish: input.publish !== false, items };
  data.folios.push(folio);
  await writeFolios(data);
  return folio;
}

export async function updateFolio(id, input) {
  const data = await readFolios();
  const folio = data.folios.find((item) => item.id === id);
  if (!folio) return null;
  if (String(input.title || '').trim()) folio.title = String(input.title).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(input.date || ''))) folio.date = String(input.date);
  if ('intro' in input) folio.intro = String(input.intro || '').trim();
  if (typeof input.publish === 'boolean') folio.publish = input.publish;
  if (Array.isArray(input.items)) {
    const items = normalizeFolioItems(input.items);
    if (items.length < 2) throw new Error('册页至少要保留两项内容。');
    ensureFolioItemsAvailable(data, items, folio.id);
    folio.items = items;
  }
  if (folio.publish !== false) await ensureFolioItemsVisible(folio.items);
  await writeFolios(data);
  return folio;
}

export async function removeFolio(id) {
  const data = await readFolios();
  const index = data.folios.findIndex((folio) => folio.id === id);
  if (index < 0) return null;
  const [folio] = data.folios.splice(index, 1);
  await writeFolios(data);
  return folio;
}

export { INBOX };
